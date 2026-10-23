/**
 * Local synthetic browser-acceptance seed for slice 5 part C (valuation
 * guides); run explicitly on an owned disposable database, never a shared
 * one. How to run it: docs/asset-finance/evidence/slice5/browser/C/README.md.
 *
 * A lender with asset finance on and no guide yet; two LOAN_ADMINs (one
 * loads, the other publishes), a CREDIT_OFFICER and a READONLY user, all with
 * a password and TOTP. An instalment-sale deal in DRAFT on the TEST EX-1 2025
 * (R1 725 000 cash price incl. VAT, R172 500 deposit), and an operating lease
 * on the TEST EX-2 2025 booked with two monthly rentals, so its end-of-term
 * choice is open today; no valuation is recorded on either asset. The guide
 * files to upload are lib/valuation-guides/__fixtures__/browser-guide-*.csv.
 * The logins go to a local file (mode 600).
 */
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { expect, it, vi } from "vitest"
import { addMonthsClamped } from "@/lib/asset-finance/dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { dealRoutes } from "@/lib/asset-finance/deal.integration-fixture"
import { approveLease, createLeaseFixture, leaseBody, payoutAndBook, signLease } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const seed = process.env.VALUATION_BROWSER_SEED === "1" ? it : it.skip
const OUT = process.env.VALUATION_BROWSER_SEED_OUT || "/tmp/cf-valuation-browser.json"
const PASSWORD = "Synthetic-Valuation-Acceptance-2026!"
const TOTP_SECRET = "JBSWY3DPEHPK3PXP"

seed("seeds the synthetic valuation-guide browser acceptance on an owned disposable PG", async () => {
  const db = new PrismaClient()
  try {
    process.env.TRUSTED_PROXY = "1"
    const token = `valuation${randomUUID().replaceAll("-", "").slice(0, 8)}`
    const fx = await createLeaseFixture(db, token)
    const setSession = (user: SessionUser | null) => { session.current = user && { user } }
    const staffAs = (id: string, role: string) => setSession({ id, email: `${id}@valuation-it.test`, role, tenantId: fx.tenantId })
    await db.loanProduct.update({ where: { id: fx.product }, data: { name: "TEST plant finance" } })

    // The deal the guide value and LTV are shown on: a DRAFT instalment sale on the EX-1.
    staffAs(fx.officer, "CREDIT_OFFICER")
    const created = await dealRoutes(fx.host).create({
      assetId: fx.assets[0], depositCents: 17_250_000, balloonCents: 20_000_000,
      firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 1),
      preset: { kind: "MONTHLY", periods: 36 }, rateBasis: "PRIME", rateMargin: "0.0100",
      entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product,
    })
    expect(created.status).toBe(201)
    const dealId = ((await created.json()) as { id: string }).id

    // The lease whose purchase election still needs an independent valuation: two rentals, so the choice is open now.
    const leaseDeal = await approveLease(fx, staffAs, leaseBody(fx, {
      assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced,
      preset: { kind: "MONTHLY", periods: 2 }, balloonCents: 100_000_000,
    }))
    await signLease(fx, db, setSession, leaseDeal)
    const leaseLoan = await payoutAndBook(fx, db, staffAs, leaseDeal)

    const hash = await bcrypt.hash(PASSWORD, 10)
    const login = async (id: string) => db.user.update({ where: { id }, data: { password: hash, totpEnabled: true, totpSecret: TOTP_SECRET }, select: { email: true, role: true } })
    const readonlyId = (await db.user.create({
      data: { tenantId: fx.tenantId, email: `readonly-${token}@staff.invalid`, name: "TEST readonly", password: hash, role: "READONLY", totpEnabled: true, totpSecret: TOTP_SECRET },
    })).id
    const staff = { loadingAdmin: await login(fx.adminA), publishingAdmin: await login(fx.adminB), creditOfficer: await login(fx.officer), readonly: await login(readonlyId) }

    // The same rows on every fresh database.
    const shape = {
      guides: await db.valuationGuide.count({ where: { tenantId: fx.tenantId } }),
      valuations: await db.assetValuation.count({ where: { tenantId: fx.tenantId } }),
      deals: (await db.assetFinanceDeal.findMany({ where: { tenantId: fx.tenantId }, select: { contractType: true, status: true } })).map((d) => `${d.contractType}:${d.status}`).sort(),
      loans: (await db.loan.findMany({ where: { tenantId: fx.tenantId }, select: { contractType: true, status: true } })).map((l) => `${l.contractType}:${l.status}`),
      assets: (await db.financedAsset.findMany({ where: { id: { in: [fx.assets[0], fx.assets[1]] } }, orderBy: { model: "asc" }, select: { make: true, model: true, year: true } })),
      roles: (await db.user.findMany({ where: { tenantId: fx.tenantId }, select: { role: true } })).map((u) => u.role).sort(),
    }
    expect(shape).toEqual({
      guides: 0,
      valuations: 0,
      deals: ["INSTALMENT_SALE:DRAFT", "OPERATING_LEASE:BOOKED"],
      loans: ["OPERATING_LEASE:ACTIVE"],
      assets: [{ make: "TEST", model: "EX-1", year: 2025 }, { make: "TEST", model: "EX-2", year: 2025 }],
      roles: ["CREDIT_OFFICER", "LOAN_ADMIN", "LOAN_ADMIN", "READONLY", "SUPER_ADMIN"],
    })

    writeFileSync(OUT, JSON.stringify({
      tenantId: fx.tenantId, slug: `af-deal-${token}`, host: fx.host, password: PASSWORD, totpSecret: TOTP_SECRET, staff,
      deal: { id: dealId, assetId: fx.assets[0] }, lease: { dealId: leaseDeal, loanId: leaseLoan, assetId: fx.assets[1] }, shape,
    }, null, 2), { mode: 0o600 })
  } finally {
    await db.$disconnect()
  }
}, 600_000)
