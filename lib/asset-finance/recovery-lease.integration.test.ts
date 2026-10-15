/**
 * A recovery of a leased asset records the inspection meter reading in the
 * recovery's own transaction (lib/asset-finance/meter-readings.ts rules), real
 * routes, a booked full-maintenance lease, a migrated Postgres. A refused reading
 * keeps no recovery.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-lease.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { dbDate } from "./dates"
import { cleanupRecoveryRows, today } from "./recovery.integration-fixture"
import { recoveryRoutes } from "./recovery-routes.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let loanId = ""
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })

suite.sequential("recovery of a leased asset records the inspection reading (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    const dealId = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[2], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced, preset: { kind: "MONTHLY", periods: 12 }, balloonCents: 100_000_000,
      maintenanceRiskModel: "LESSEE_SETTLED", escalationRate: "0",
    }))
    await signLease(fx, database(), setSession, dealId)
    loanId = await payoutAndBook(fx, database(), staff, dealId)
  }, 600_000)
  afterAll(async () => {
    if (!db) return
    await cleanupRecoveryRows(db, dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupLeaseRows(db, dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  }, 120_000)

  it("refuses a reading below the lease's start reading with no recovery; accepts a plausible one and links it", async () => {
    staff(fx.officer, "CREDIT_OFFICER")
    const r = recoveryRoutes(fx.host)
    const body = (value: number) => ({ route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "TEST Yard", condition: "Synthetic: fair", meterReading: { value } })
    const loan = await database().loan.findUniqueOrThrow({ where: { id: loanId }, select: { ncaRegime: true } })
    expect(loan.ncaRegime).toBe("NON_NCA")
    const deal = await database().assetFinanceDeal.findFirstOrThrow({ where: { loan: { id: loanId } }, select: { usageUnit: true } })
    const loanRow = await database().loan.findUniqueOrThrow({ where: { id: loanId }, select: { assetId: true } })
    await database().assetMeterReading.create({ data: {
      tenantId: fx.tenantId, assetId: loanRow.assetId ?? "", loanId, readingDate: dbDate(today()), value: 1000, unit: deal.usageUnit ?? "HOURS", source: "STAFF", recordedById: fx.officer,
    } })
    const low = await r.create(loanId, body(900))
    expect(low.status).toBe(409)
    expect(String(low.body.error)).toMatch(/may not be below an earlier one/)
    expect(await database().recovery.count({ where: { loanId } })).toBe(0)
    const created = await r.create(loanId, body(1050))
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const recovery = await database().recovery.findUniqueOrThrow({ where: { id: created.body.id as string } })
    const reading = await database().assetMeterReading.findUniqueOrThrow({ where: { id: recovery.meterReadingId ?? "" } })
    expect(reading).toMatchObject({ loanId, value: 1050, source: "STAFF", recordedById: fx.officer })
  }, 120_000)
})
