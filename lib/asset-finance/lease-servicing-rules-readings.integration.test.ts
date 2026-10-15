/**
 * Each clause of the slice 3 C6 meter-reading rules, and the maintenance
 * fund's insert and delete rules, refuses its attack, and is what refuses it:
 * the same attack goes through with that one clause (or the trigger) taken
 * out, inside a rolled-back transaction. A lease's reading is dated no later
 * than today, from the lease's start, of its own asset; never above a
 * later-dated reading (an equal one, earlier, later or the same day, is
 * admitted); a fund is opened for a full-maintenance lease only and is never
 * deleted.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-rules-readings.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { backdateLease, ruleAdmits, ruleRefuses } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
/** fml: a full-maintenance lease with contracted hours (its start reading: 400 h on its start date); operating: no fund. */
const ids = { fml: "", operating: "", start: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const today = () => sastCalendarDate(new Date())
const day = (offset: number) => fromDayNumber(toDayNumber(today()) + offset)
const R = "guardAssetMeterReading"

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const refuses = (rule: Parameters<typeof ruleRefuses>[1], message: RegExp, attack: (tx: Tx) => Promise<unknown>) => ruleRefuses(database(), rule, message, attack)
const without = (fn: string, clause: string, replacement = "") => ({ fn, replace: [clause, replacement] as const })

async function book(assetId: string, contractType: "FULL_MAINTENANCE_LEASE" | "OPERATING_LEASE"): Promise<string> {
  const dealId = await approveLease(fx, staff, leaseBody(fx, { assetId, contractType, rentalTiming: "ARREARS", entityId: fx.evidenced }))
  await signLease(fx, database(), setSession, dealId)
  const loanId = await payoutAndBook(fx, database(), staff, dealId)
  await backdateLease(database(), loanId, 2)
  return loanId
}

const reading = (tx: Tx, readingDate: string, value: number, assetId = fx.assets[1]) => tx.assetMeterReading.create({
  data: { tenantId: fx.tenantId, assetId, loanId: ids.fml, readingDate: dbDate(readingDate), value, unit: "HOURS", source: "STAFF", recordedById: fx.officer },
})
const BOUNDS = /dated no later than today, of its lease's asset, from the lease's start/
const MONOTONIC = /Meter readings are monotonic/
const fund = (tx: Tx) => tx.maintenanceFund.create({ data: { tenantId: fx.tenantId, loanId: ids.operating, riskModel: "LENDER_RISK", leaseEndDate: dbDate(day(365)) }, select: { id: true } })

suite.sequential("lease servicing rules: meter readings and the fund's lifecycle, clause by clause (each removed → the attack goes through)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    ids.fml = await book(fx.assets[1], "FULL_MAINTENANCE_LEASE")
    ids.operating = await book(fx.assets[2], "OPERATING_LEASE")
    ids.start = sastCalendarDate((await database().loan.findUniqueOrThrow({ where: { id: ids.fml } })).startDate)
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("a lease's reading is dated no later than today, from the lease's start, of the lease's own asset", async () => {
    await ruleAdmits(database(), (tx) => reading(tx, today(), 900))
    await refuses(without(R, `(NEW."readingDate" > (now() AT TIME ZONE 'Africa/Johannesburg')::date AND NOT EXISTS (`, "(FALSE AND NOT EXISTS ("), BOUNDS,
      (tx) => reading(tx, day(1), 900))
    await refuses(without(R, ` AND NEW."readingDate" >= (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date`), BOUNDS,
      (tx) => reading(tx, fromDayNumber(toDayNumber(ids.start) - 1), 100))
    await refuses(without(R, ` AND l."assetId" = NEW."assetId"`), BOUNDS, (tx) => reading(tx, today(), 900, fx.assets[2]))
  })

  it("a reading is never above a later-dated one; an equal reading, earlier, later or the same day, is admitted", async () => {
    await refuses(without(R, ` OR (r."readingDate" > NEW."readingDate" AND r."value" < NEW."value")`), MONOTONIC,
      async (tx) => { await reading(tx, today(), 900); await reading(tx, day(-1), 950) })
    await ruleAdmits(database(), (tx) => reading(tx, today(), 400)) // equal to the start reading
    await ruleAdmits(database(), async (tx) => { await reading(tx, today(), 900); await reading(tx, day(-1), 900) }) // equal to a later one
    await ruleAdmits(database(), async (tx) => { await reading(tx, today(), 900); await reading(tx, today(), 900) }) // the same day
  })

  it("a fund is opened unsettled for a full-maintenance lease only, and never deleted", async () => {
    const rule = { table: "MaintenanceFund", trigger: "MaintenanceFund_guard" }
    await refuses(rule, /written unsettled for a full-maintenance lease/, fund)
    await refuses(rule, /never deleted/, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      const { id } = await fund(tx) // test setup: a fund with no movements, behind the guard
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin")
      await tx.maintenanceFund.delete({ where: { id } })
    })
  })
})
