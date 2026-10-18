/**
 * Local synthetic acceptance seed for the lender-owned templates browser run
 * (docs/asset-finance/evidence/lender-owned-templates/browser/). Invoked
 * explicitly on an owned, disposable, migrated database only:
 *
 *   TWO_LENDER_BROWSER_SEED=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/documents/templates/two-lender-browser-seed.test.ts
 *
 * Two synthetic DEMO lenders (isDemoLender, staff TOTP required), APPROVED deals
 * built through the real routes WITHOUT any adopted template: adoption,
 * approval and publication happen in the browser. Private metadata (passwords,
 * TOTP secrets, ids) goes to /tmp/claude-1003/lot-browser.json, never the repo.
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped } from "../../dates"
import { dealRoutes } from "../../deal.integration-fixture"
import { createSigningFixture, type SigningFixture } from "../../deal-signing.integration-fixture"
import { approveDeal } from "../../payout-booking.integration-fixture"
import { approveLease, leaseBody, type LeaseFixture } from "../../lease.integration-fixture"
import { syntheticSaIdNumber } from "../../synthetic-sa-id.integration-fixture"
import { POST as entityQuoteAcknowledgeRoute } from "@/app/api/portal/asset-finance/deals/[id]/nca-quote/acknowledge/route"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const seed = process.env.TWO_LENDER_BROWSER_SEED === "1" ? it : it.skip
const OUT = "/tmp/claude-1003/lot-browser.json"

const IDENTITY = {
  alpha: {
    legalName: "Synthetic Alpha Asset Finance (Pty) Ltd", brandName: "Alpha Demo Finance", ncrNumber: "NCRCP90001", fscaNumber: "90001",
    companyRegNumber: "2099/900001/07", registeredOffice: "1 Alpha Synthetic Avenue\nAlphaville\n9001", publicEmail: "hello@alpha-demo.invalid",
    publicPhone: "+27 11 900 0001", collectionsEmail: "collections@alpha-demo.invalid", collectionsPhone: "+27 11 900 0002",
  },
  bravo: {
    legalName: "Synthetic Bravo Equipment Credit (Pty) Ltd", brandName: "Bravo Demo Credit", ncrNumber: "NCRCP90002", fscaNumber: "90002",
    companyRegNumber: "2099/900002/07", registeredOffice: "2 Bravo Synthetic Road\nBravotown\n9002", publicEmail: "hello@bravo-demo.invalid",
    publicPhone: "+27 21 900 0003", collectionsEmail: "collections@bravo-demo.invalid", collectionsPhone: "+27 21 900 0004",
  },
} as const

seed("seeds two synthetic demo lenders with approved deals and no adopted templates", async () => {
  const db = new PrismaClient()
  const out: Record<string, unknown> = { synthetic: true }
  try {
    process.env.TRUSTED_PROXY = "1"
    const password = `Synthetic-Lot-${randomUUID().slice(0, 8)}!`
    for (const name of ["alpha", "bravo"] as const) {
      const t = `${name}${randomUUID().replaceAll("-", "").slice(0, 10)}`
      let fx: SigningFixture | null = null
      const staff = (id: string, role: string) => { session.current = { user: { id, role, email: `${id}@synthetic.invalid`, tenantId: fx?.tenantId ?? `t_af_deal_${t}` } } }
      fx = await createSigningFixture(db, t, staff, undefined, { templates: false })
      const f = fx
      await db.tenantConfig.update({ where: { tenantId: f.tenantId }, data: { ...IDENTITY[name], isDemoLender: true, requireStaffTotp: true, featureAssetFinance: true, assetFinanceLegalWordingApproved: false } })
      await db.vatConfig.create({ data: { tenantId: f.tenantId, vatNumber: name === "alpha" ? "4900000001" : "4900000002", registeredName: IDENTITY[name].legalName, address: IDENTITY[name].registeredOffice.replaceAll("\n", ", ") } })
      const deals: Record<string, string> = { commercial1: f.dealId }
      const notes: string[] = []
      deals.commercial2 = await approveDeal(f, f.assets[1], staff, db)
      const routes = dealRoutes(f.host)

      if (name === "alpha") {
        // CPA instalment sale: a small company (R1.5m turnover) — outside the NCA, inside the CPA.
        const small = await db.businessEntity.create({ data: {
          tenantId: f.tenantId, type: "COMPANY", legalName: "Synthetic Small Works (Pty) Ltd", registrationNumber: `2099/${t.slice(5, 11)}/03`,
          addressLine1: "11 Synthetic Yard", city: "Johannesburg", province: "Gauteng", postalCode: "2000",
          annualTurnover: 150_000_000, financialYearEnd: new Date("2026-02-28T00:00:00Z"), financialsEvidenceIds: [`afs-small-${t}`],
        } })
        await db.entityRelationship.create({ data: { tenantId: f.tenantId, entityId: small.id, clientId: f.director, role: "DIRECTOR" } })
        staff(f.officer, "CREDIT_OFFICER")
        const created = await routes.create({
          assetId: f.assets[2], depositCents: 17_250_000, balloonCents: 20_000_000, firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 1),
          preset: { kind: "MONTHLY", periods: 36 }, rateBasis: "PRIME", rateMargin: "0.0100", entityId: small.id, supplierId: f.supplier, productId: f.product,
        })
        expect(created.status, await created.clone().text()).toBe(201)
        const cpa = ((await created.json()) as { id: string }).id
        expect((await routes.submit(cpa)).status).toBe(200)
        const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: cpa } })
        const override = await db.ncaRegimeOverride.findFirst({ where: { applicationId: deal.applicationId, status: "PENDING" } })
        if (override) { staff(f.adminB, "LOAN_ADMIN"); expect((await routes.decideOverride(override.id, { decision: "APPROVE", note: "Synthetic AFS agree" })).status).toBe(200) }
        staff(f.officer, "CREDIT_OFFICER")
        expect((await routes.financials(cpa, {
          periodEnd: "2026-02-28", turnoverCents: 150_000_000, ebitdaCents: 50_000_000, totalAssetsCents: 150_000_000,
          totalLiabilitiesCents: 20_000_000, existingDebtServiceCents: 1_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 0,
        })).status).toBe(200)
        staff(f.adminA, "LOAN_ADMIN")
        const decided = await routes.decide(cpa, { decision: "APPROVE", reasons: ["Synthetic DSCR comfortably above policy"] })
        expect(decided.status, await decided.clone().text()).toBe(200)
        expect((await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: cpa } })).isaCpaApplies).toBe(true)
        deals.cpaIsa = cpa

        // Entity NCA finance lease with the PASQ acknowledged (best effort; recorded if not feasible).
        try {
          staff(f.officer, "CREDIT_OFFICER")
          const nca = await routes.create({
            assetId: f.assets[3], depositCents: 17_250_000, balloonCents: 30_000_000, firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 2),
            preset: { kind: "MONTHLY", periods: 60 }, rateBasis: "PRIME", rateMargin: "0.0100", contractType: "FINANCE_LEASE",
            entityId: f.unevidenced, supplierId: f.supplier, productId: f.product,
          })
          if (nca.status !== 201) throw Error(`create ${nca.status} ${await nca.text()}`)
          const id = ((await nca.json()) as { id: string }).id
          const step = async (label: string, r: Promise<Response>, ok = 200) => { const x = await r; if (x.status !== ok) throw Error(`${label} ${x.status} ${await x.text()}`); return x }
          await step("submit", routes.submit(id))
          await step("bureau", routes.bureau(id))
          await step("financials", routes.financials(id, {
            periodEnd: "2026-02-28", turnoverCents: 180_000_000, ebitdaCents: 55_000_000, totalAssetsCents: 190_000_000,
            totalLiabilitiesCents: 45_000_000, existingDebtServiceCents: 5_000_000, avgMonthlyCreditsCents: 15_000_000, returnedDebitsCount: 0,
          }))
          staff(f.adminA, "LOAN_ADMIN")
          await step("affordability", routes.affordability(id, { recklessLendingNote: "Verified business cash flow supports the finance-lease instalment." }))
          session.current = { user: { id: f.director, email: f.directorEmail, role: "CLIENT", tenantId: f.tenantId } }
          await step("creditLife", routes.creditLife(id, { election: "DECLINED" }))
          staff(f.adminA, "LOAN_ADMIN")
          await step("decide", routes.decide(id, { decision: "APPROVE", reasons: ["Affordable on verified entity cash flow"] }))
          const quote = (await (await step("ncaQuote", routes.ncaQuote(id), 201)).json()) as { sha256: string }
          session.current = { user: { id: f.director, email: f.directorEmail, role: "CLIENT", tenantId: f.tenantId } }
          await step("pasqAck", entityQuoteAcknowledgeRoute(new NextRequest(`http://${f.host}/api/portal/asset-finance/deals/${id}/nca-quote/acknowledge`, {
            method: "POST", headers: { host: f.host, "content-type": "application/json" }, body: JSON.stringify({ documentSha256: quote.sha256 }),
          }), { params: Promise.resolve({ id }) }))
          deals.ncaFinanceLease = id
        } catch (error) {
          notes.push(`NCA deal not seeded: ${(error as Error).message.slice(0, 600)}`)
        }
      } else {
        // CPA operating lease to a sole proprietor (a natural person).
        const lessee = (await db.client.create({ data: {
          tenantId: f.tenantId, firstName: "Synthetic", lastName: "Soleprop", email: `soleprop-${t}@client.invalid`, phone: `0003${t.slice(5, 11)}`,
          idNumber: syntheticSaIdNumber(), popiaConsentGiven: true, addressLine1: "3 Synthetic Lane", city: "Pretoria", province: "Gauteng", postalCode: "0001",
        } })).id
        const lfx = { ...f, lessee, lenderName: IDENTITY.bravo.legalName } as LeaseFixture
        deals.cpaOperatingLease = await approveLease(lfx, staff, leaseBody(lfx, { assetId: f.assets[2], clientId: lessee, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS" }))
        expect((await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: deals.cpaOperatingLease } })).cpaApplies).toBe(true)
      }

      // Synthetic slug/host and named staff with real bcrypt passwords and TOTP secrets.
      const slug = `${name}-demo`
      await db.tenant.update({ where: { id: f.tenantId }, data: { slug, domain: `${name}.localhost`, name: IDENTITY[name].brandName } })
      const hash = await bcrypt.hash(password, 10)
      const users: Record<string, { id: string; email: string; secret: string; role: string }> = {}
      for (const [label, id, role] of [["author", f.adminA, "LOAN_ADMIN"], ["approver", f.adminB, "LOAN_ADMIN"], ["officer", f.officer, "CREDIT_OFFICER"]] as const) {
        const secret = randomUUID().replaceAll("-", "").toUpperCase().replace(/[^A-Z2-7]/g, "").padEnd(16, "A").slice(0, 16)
        const email = `${name}-${label}@synthetic.invalid`
        await db.user.update({ where: { id }, data: { email, name: `Synthetic ${name} ${label}`, password: hash, totpEnabled: true, totpSecret: secret, active: true } })
        users[label] = { id, email, secret, role }
      }
      expect(await db.documentTemplate.count({ where: { tenantId: f.tenantId } })).toBe(0)
      out[name] = { tenantId: f.tenantId, slug, host: `${name}.localhost`, users, deals, notes }
    }
    out.password = password
    mkdirSync("/tmp/claude-1003", { recursive: true })
    writeFileSync(OUT, JSON.stringify(out, null, 2), { mode: 0o600 })
  } finally {
    await db.$disconnect()
  }
}, 300_000)
