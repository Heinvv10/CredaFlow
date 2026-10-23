/**
 * Local synthetic browser-acceptance seed for slice 5 part B (telematics); run
 * explicitly on an owned disposable database, never a shared one. How to run
 * it: docs/asset-finance/evidence/slice5/browser/B/README.md.
 *
 * A demo lender with the dealer portal on; two operating leases (1 500 h a
 * year, start reading 1 000 h) and an instalment sale, booked and moved 30
 * days back; simulated devices SIM-TAMPER-0001, SIM-ROLLBACK-0002 (the leases)
 * and SIM-STEADY-0003 (the sale), installed on the start date; the TAMPER
 * asset's recorded tracker id is its device's. A second state: an operating
 * lease signed but not paid out (its TRACKER_CONFIRMED item still open) with
 * SIM-STEADY-0005, and a dealer-captured deal booked today with
 * SIM-STEADY-0004. Nothing is polled: acceptance drives the cron route. Staff
 * sign in with a password and TOTP, the dealer with a password; the logins go
 * to a local file (mode 600).
 */
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { expect, it, vi } from "vitest"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { approveLease, leaseBody, signLease } from "@/lib/asset-finance/lease.integration-fixture"
import { bookedDealerDeal } from "@/lib/dealer/dealer-booking.integration-fixture"
import { insertDealer, insertDealerUser, type DealerFixture } from "@/lib/dealer/dealer.integration-fixture"
import { bookInstalmentSale, bookOperatingLease, createTelematicsFixture, daysAgo, installDevice, loanStartDate, today } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const seed = process.env.TELEMATICS_BROWSER_SEED === "1" ? it : it.skip
const OUT = process.env.TELEMATICS_BROWSER_SEED_OUT || "/tmp/cf-telematics-browser.json"
const PASSWORD = "Synthetic-Telematics-Acceptance-2026!"
const TOTP_SECRET = "JBSWY3DPEHPK3PXP"

seed("seeds the synthetic telematics browser acceptance on an owned disposable PG", async () => {
  const db = new PrismaClient()
  try {
    process.env.TRUSTED_PROXY = "1"
    const token = `telematics${randomUUID().replaceAll("-", "").slice(0, 8)}`
    const fx = await createTelematicsFixture(db, token)
    const setSession = (user: SessionUser | null) => { session.current = user && { user } }
    // The fixture's product serves leases and sales alike: name it for both.
    await db.loanProduct.update({ where: { id: fx.product }, data: { name: "TEST plant finance" } })
    // The TAMPER asset's recorded tracker id is its device's ("matches the recorded tracker id"); fixed once payout attests it.
    await db.financedAsset.update({ where: { id: fx.assets[1] }, data: { trackerId: "SIM-TAMPER-0001" } })

    const loans = {
      tamper: await bookOperatingLease(db, fx, setSession, fx.assets[1], 30),
      rollback: await bookOperatingLease(db, fx, setSession, fx.assets[2], 30),
      sale: await bookInstalmentSale(db, fx, setSession, fx.assets[3], 30),
    }
    const installedOn = await loanStartDate(db, loans.tamper)
    expect(installedOn).toBe(daysAgo(30))
    const devices = {
      tamper: await installDevice(fx, fx.assets[1], "SIM-TAMPER-0001", installedOn),
      rollback: await installDevice(fx, fx.assets[2], "SIM-ROLLBACK-0002", installedOn),
      sale: await installDevice(fx, fx.assets[3], "SIM-STEADY-0003", installedOn),
    }

    // Before payout: an operating lease approved and signed, not paid out, so its TRACKER_CONFIRMED item is still open.
    const staffAs = (id: string, role: string) => setSession({ id, email: `${id}@telematics-it.test`, role, tenantId: fx.tenantId })
    const unpaidDeal = await approveLease(fx, staffAs, leaseBody(fx, {
      assetId: fx.assets[0], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced,
      usageAllowancePerYear: 1_500, usageUnit: "HOURS", excessRateCents: 35_000,
    }))
    await signLease(fx, db, setSession, unpaidDeal)
    const unpaidDevice = await installDevice(fx, fx.assets[0], "SIM-STEADY-0005", daysAgo(5))

    // A demo lender from here on: its templates were approved as this lender's own before the bookings.
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { isDemoLender: true, featureDealerPortal: true } })
    const hash = await bcrypt.hash(PASSWORD, 10)
    const staffLogin = async (id: string) => (await db.user.update({ where: { id }, data: { password: hash, totpEnabled: true, totpSecret: TOTP_SECRET }, select: { email: true, role: true } }))
    const newStaff = async (label: string, role: "COLLECTIONS_OFFICER" | "READONLY") =>
      (await db.user.create({ data: { tenantId: fx.tenantId, email: `${label}-${token}@staff.invalid`, name: `TEST ${label}`, password: hash, role, totpEnabled: true, totpSecret: TOTP_SECRET } })).id
    const staff = {
      loanAdmin: await staffLogin(fx.adminA),
      creditOfficer: await staffLogin(fx.officer),
      collections: await staffLogin(await newStaff("collections", "COLLECTIONS_OFFICER")),
      readonly: await staffLogin(await newStaff("readonly", "READONLY")),
    }
    const dealerId = insertDealer(fx.tenantId, fx.adminA, { name: `TEST Plant Dealer ${token}` })
    const dealerUserId = insertDealerUser(fx.tenantId, dealerId, { role: "DEALER_ADMIN", byUser: fx.adminA })
    const dealer = await db.dealerUser.update({ where: { id: dealerUserId }, data: { passwordHash: hash }, select: { email: true } })
    // A deal the dealer captured, booked today, with a device: the dealer's deal view must show no telematics.
    const supplierAccount = (await db.supplierBankAccount.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "APPROVED" }, select: { id: true } })).id
    const dealerFx = { ...fx, dealerA: dealerId, dealerB: dealerId, adminUserA: dealerUserId, salesUserA: dealerUserId, userB: dealerUserId, supplierAccount } as DealerFixture
    const dealerDeal = bookedDealerDeal(dealerFx, dealerId, dealerUserId)
    const dealerAsset = (await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealerDeal.dealId }, select: { assetId: true } })).assetId
    const dealerDevice = await installDevice(fx, dealerAsset, "SIM-STEADY-0004", today())

    const dealerShape = await db.loan.findUniqueOrThrow({ where: { id: dealerDeal.loanId }, select: { contractType: true } })
    expect(await db.payoutChecklistItem.count({ where: { dealId: unpaidDeal, item: "TRACKER_CONFIRMED", confirmedAt: { not: null } } })).toBe(0)
    // The same rows on every fresh database.
    const shape = {
      devices: await db.trackerDevice.findMany({ where: { tenantId: fx.tenantId }, orderBy: { externalDeviceId: "asc" }, select: { externalDeviceId: true, provider: true, status: true } }),
      loans: (await db.loan.findMany({ where: { tenantId: fx.tenantId }, select: { contractType: true, status: true } })).map((l) => `${l.contractType}:${l.status}`).sort(),
      readings: await db.assetMeterReading.count({ where: { tenantId: fx.tenantId } }),
      events: await db.telematicsEvent.count({ where: { tenantId: fx.tenantId } }),
      roles: (await db.user.findMany({ where: { tenantId: fx.tenantId }, select: { role: true } })).map((u) => u.role).sort(),
    }
    expect(shape).toEqual({
      devices: [
        { externalDeviceId: "SIM-ROLLBACK-0002", provider: "simulated", status: "ACTIVE" },
        { externalDeviceId: "SIM-STEADY-0003", provider: "simulated", status: "ACTIVE" },
        { externalDeviceId: "SIM-STEADY-0004", provider: "simulated", status: "ACTIVE" },
        { externalDeviceId: "SIM-STEADY-0005", provider: "simulated", status: "ACTIVE" },
        { externalDeviceId: "SIM-TAMPER-0001", provider: "simulated", status: "ACTIVE" },
      ],
      loans: [`${dealerShape.contractType}:ACTIVE`, "INSTALMENT_SALE:ACTIVE", "OPERATING_LEASE:ACTIVE", "OPERATING_LEASE:ACTIVE"].sort(),
      readings: 2,
      events: 0,
      roles: ["COLLECTIONS_OFFICER", "CREDIT_OFFICER", "LOAN_ADMIN", "LOAN_ADMIN", "READONLY", "SUPER_ADMIN"],
    })

    writeFileSync(OUT, JSON.stringify({
      tenantId: fx.tenantId, slug: `af-deal-${token}`, host: fx.host, password: PASSWORD, totpSecret: TOTP_SECRET, installedOn,
      staff, dealer: { email: dealer.email, password: PASSWORD }, loans, devices, shape,
      beforePayout: { dealId: unpaidDeal, deviceId: unpaidDevice }, dealerDeal: { ...dealerDeal, deviceId: dealerDevice },
    }, null, 2), { mode: 0o600 })
  } finally {
    await db.$disconnect()
  }
}, 600_000)
