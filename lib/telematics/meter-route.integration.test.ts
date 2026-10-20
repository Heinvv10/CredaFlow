/**
 * Where a tracker's meter reading goes, on real Postgres (docs/asset-finance/
 * SLICE5.md part B): an operating or full-maintenance lease while it runs, at
 * most one a day, bound to its event; an instalment sale or a finance lease
 * keeps it as a device reading only; nothing is written from the end of the
 * term, after an end of term or an accepted termination, so the staff final
 * reading at the inspection is never blocked. Each database clause refuses
 * its attack and is what refuses it (removed, the attack goes through).
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/meter-route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient, TrackerDevice } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "@/lib/asset-finance/dates"
import { ruleAdmits, ruleRefuses } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { recordMeterReading } from "@/lib/asset-finance/meter-readings"
import { pollTenant } from "./poll"
import { ingestEvent } from "./ingest"
import { PACE_TABLE } from "./__fixtures__/pace-table"
import {
  bookInstalmentSale, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, eveningOf, installDevice, meterEvent, telematicsTestClient, today,
} from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let lease: { loanId: string; device: TrackerDevice }
let sale: { loanId: string; device: TrackerDevice }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const G = "guardTelematicsMeterReading"
const RUNNING = /written only while the lease runs/

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const ctx = () => ({ now: new Date(), simulated: true, retentionDays: 90 })
const ingest = (tx: Tx, device: TrackerDevice, value: number, day: string) => ingestEvent(tx as never, device, meterEvent(device.externalDeviceId, eveningOf(day), value), ctx())
async function setup(tx: Tx, ...statements: [string, ...unknown[]][]): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
  for (const [statement, ...params] of statements) await tx.$executeRawUnsafe(statement, ...params)
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin")
}
/** A meter event and its TELEMATICS reading, written straight to the tables. */
async function direct(tx: Tx, on: { loanId: string; device: TrackerDevice }, day: string, value: number, over: Record<string, unknown> = {}) {
  const event = await tx.telematicsEvent.create({ data: {
    tenantId: fx.tenantId, deviceId: on.device.id, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind: "METER",
    occurredAt: eveningOf(day), meterValue: value, meterUnit: "HOURS", simulated: true,
  } })
  return tx.assetMeterReading.create({ data: {
    tenantId: fx.tenantId, assetId: on.device.assetId, loanId: on.loanId, readingDate: dbDate(day), value, unit: "HOURS",
    source: "TELEMATICS", telematicsEventId: event.id, ...over,
  } })
}
const expectOutcome = async (tx: Tx, device: TrackerDevice, value: number, day: string, outcome: string) => {
  const result = await ingest(tx, device, value, day)
  if (!result.stored || result.meterOutcome !== outcome) throw new Error(`expected ${outcome}, got ${JSON.stringify(result)}`)
}
const ACCEPTED_QUOTE = `INSERT INTO "LeaseTerminationQuote" ("id", "tenantId", "loanId", "quotedOn", "terminationDate", "validUntil", "cpaCancellation",
  "remainingRentals", "pvCents", "penaltyCents", "arrearsCents", "invoiceExclVatCents", "invoiceVatCents", "totalCents", "basis", "status", "acceptedAt")
  VALUES (gen_random_uuid()::text, $1, $2, CURRENT_DATE, CURRENT_DATE, CURRENT_DATE, false, 0, 0, 0, 0, 0, 0, 0, 'Synthetic accepted quote', 'ACCEPTED', now())`
const END_OF_TERM = `INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, 'EXPIRY', 'RETURN', now())`
const TERM_ENDED = `UPDATE "LeaseRental" SET "dueDate" = ("dueDate" - INTERVAL '10 years')::date WHERE "loanId" = $1`

suite.sequential("telematics meter readings: leases only, while they run, one a day, bound to the event (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    const leaseLoan = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    const saleLoan = await bookInstalmentSale(database(), fx, setSession, fx.assets[2])
    // A staff reading on day 25 (1 100 h) caps the device's days 17 to 24 (1 102 h and up).
    await database().$transaction((tx) => recordMeterReading(tx as never, { tenantId: fx.tenantId, userId: fx.officer }, {
      loanId: leaseLoan, readingDate: daysAgo(5), value: 1_100, evidenceDocumentId: null, today: today(),
    }))
    const leaseDevice = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", daysAgo(30))
    const saleDevice = await installDevice(fx, fx.assets[2], "SIM-STEADY-2", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    lease = { loanId: leaseLoan, device: await database().trackerDevice.findUniqueOrThrow({ where: { id: leaseDevice } }) }
    sale = { loanId: saleLoan, device: await database().trackerDevice.findUniqueOrThrow({ where: { id: saleDevice } }) }
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("writes a lease's days as TELEMATICS readings, holds the days above a later reading, one reading a day", async () => {
    const meters = await database().telematicsEvent.findMany({ where: { deviceId: lease.device.id, kind: "METER", occurredAt: { lt: eveningOf(daysAgo(4)) } }, orderBy: { occurredAt: "asc" } })
    expect(meters.map((m) => m.meterOutcome)).toEqual([...Array(17).fill("RECORDED"), ...Array(8).fill("HELD"), "RECORDED"])
    const held = await database().telematicsHeldReading.findMany({ where: { loanId: lease.loanId } })
    expect(new Set(held.map((h) => h.reason))).toEqual(new Set(["ABOVE_LATER"]))
    const readings = await database().assetMeterReading.findMany({ where: { loanId: lease.loanId, source: "TELEMATICS" } })
    expect(readings.every((r) => r.recordedById === null && r.recordedByClientId === null && r.telematicsEventId)).toBe(true)
    // A second meter event on a day that has its reading is kept as a device reading.
    const sameDay = await database().$transaction((tx) => ingest(tx, lease.device, 1_000 + 6 * 3, daysAgo(27)))
    expect(sameDay).toMatchObject({ stored: true, meterOutcome: "SAME_DAY" })
    await ruleRefuses(database(), { index: "AssetMeterReading_telematics_one_per_day" }, /Unique constraint failed|AssetMeterReading_telematics_one_per_day/,
      (tx) => direct(tx, lease, daysAgo(27), 1_000 + 6 * 3))
  }, 120_000)

  it("keeps an instalment sale's (and a finance lease's) meter as a device reading, and the database refuses writing it", async () => {
    const meters = await database().telematicsEvent.findMany({ where: { deviceId: sale.device.id, kind: "METER" } })
    expect(meters.length).toBeGreaterThan(25)
    expect(new Set(meters.map((m) => m.meterOutcome))).toEqual(new Set(["NOT_LEASE"]))
    expect(await database().assetMeterReading.count({ where: { assetId: sale.device.assetId } })).toBe(0)
    await ruleAdmits(database(), async (tx) => {
      await setup(tx, [`UPDATE "Loan" SET "contractType" = 'FINANCE_LEASE' WHERE "id" = $1`, sale.loanId])
      await expectOutcome(tx, sale.device, 5_000, today(), "NOT_LEASE")
    })
    for (const contractType of ["INSTALMENT_SALE", "FINANCE_LEASE"]) {
      await ruleRefuses(database(), { fn: G, replace: [` OR loan_row."contractType"::text NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')`, ""] },
        /of an operating or full-maintenance lease of its asset/,
        async (tx) => {
          await setup(tx, [`UPDATE "Loan" SET "contractType" = $2::"ContractType", "cpaApplies" = NULL, "cpaRule" = NULL WHERE "id" = $1`, lease.loanId, contractType])
          await direct(tx, lease, daysAgo(10), 1_098)
        })
    }
  }, 120_000)

  it("writes nothing from the end of the term, after an end of term or an accepted termination; the staff final reading still goes in", async () => {
    const cases: [string, [string, ...unknown[]], string][] = [
      ["term ended", [TERM_ENDED, lease.loanId], ` OR NEW."readingDate" >= COALESCE(public."leaseTermEnd"(NEW."loanId", NEW."tenantId"), NEW."readingDate")`],
      ["end of term", [END_OF_TERM, fx.tenantId, lease.loanId], `
     OR EXISTS (SELECT 1 FROM "LeaseEndOfTerm" x WHERE x."loanId" = NEW."loanId" AND x."tenantId" = NEW."tenantId")`],
      ["accepted termination", [ACCEPTED_QUOTE, fx.tenantId, lease.loanId], `
     OR EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId" AND q."status" = 'ACCEPTED')`],
    ]
    for (const [, statement, clause] of cases) {
      await ruleAdmits(database(), async (tx) => {
        await setup(tx, statement)
        await expectOutcome(tx, lease.device, 1_098, daysAgo(10), "LEASE_NOT_RUNNING")
        // The inspection's staff reading, above every device reading, is admitted.
        const final = await recordMeterReading(tx as never, { tenantId: fx.tenantId, userId: fx.officer }, { loanId: lease.loanId, readingDate: today(), value: 1_500, evidenceDocumentId: null, today: today() })
        if (final.kind !== "recorded") throw new Error(JSON.stringify(final))
      })
      await ruleRefuses(database(), { fn: G, replace: [clause, ""] }, RUNNING, async (tx) => {
        await setup(tx, statement)
        await direct(tx, lease, daysAgo(10), 1_098)
      })
    }
    await ruleRefuses(database(), { fn: G, replace: [`loan_row."status"::text NOT IN ('ACTIVE', 'DEFAULTED')`, "FALSE"] }, RUNNING, async (tx) => {
      await setup(tx, [`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, lease.loanId])
      await direct(tx, lease, daysAgo(10), 1_098)
    })
  }, 120_000)

  it("binds a TELEMATICS reading to its meter event's value, date and asset, with no client, and a staff one to a held reading", async () => {
    const BINDING = /its meter event's value, unit, SAST date and asset/
    await ruleAdmits(database(), (tx) => direct(tx, lease, daysAgo(10), 1_098))
    for (const [clause, over] of [
      [` OR ev."meterValue" <> NEW."value"`, { value: 1_099 }],
      [`
     OR (ev."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <> NEW."readingDate"`, { readingDate: dbDate(daysAgo(11)) }],
    ] as const) {
      await ruleRefuses(database(), { fn: G, replace: [clause, ""] }, BINDING, (tx) => direct(tx, lease, daysAgo(10), 1_098, over))
    }
    await ruleRefuses(database(), { fn: G, replace: [` OR ev."assetId" <> NEW."assetId"`, ""] }, BINDING, async (tx) => {
      const other = await tx.telematicsEvent.create({ data: {
        tenantId: fx.tenantId, deviceId: sale.device.id, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind: "METER",
        occurredAt: eveningOf(daysAgo(10)), meterValue: 1_098, meterUnit: "HOURS", simulated: true,
      } })
      await tx.assetMeterReading.create({ data: {
        tenantId: fx.tenantId, assetId: lease.device.assetId, loanId: lease.loanId, readingDate: dbDate(daysAgo(10)), value: 1_098, unit: "HOURS", source: "TELEMATICS", telematicsEventId: other.id,
      } })
    })
    await ruleRefuses(database(), { fn: G, replace: [`ELSIF NOT EXISTS (`, "ELSIF FALSE AND NOT EXISTS ("] }, /is the acceptance of a held reading/,
      (tx) => direct(tx, lease, daysAgo(10), 1_098, { recordedById: fx.officer }))
    const shape = { table: "AssetMeterReading", constraint: "AssetMeterReading_telematics_shape" }
    await ruleRefuses(database(), shape, /AssetMeterReading_telematics_shape/, (tx) => direct(tx, lease, daysAgo(10), 1_098, { recordedByClientId: fx.lessee }))
    await ruleRefuses(database(), shape, /AssetMeterReading_telematics_shape/, (tx) => direct(tx, lease, daysAgo(10), 1_098, { source: "STAFF", recordedById: fx.officer }))
  }, 120_000)

  it("telematicsPaceCeiling is paceCeiling, value for value", async () => {
    await ruleAdmits(database(), async (tx) => {
      for (const row of PACE_TABLE) {
        await setup(tx,
          [`DELETE FROM "AssetMeterReading" WHERE "loanId" = $1`, lease.loanId],
          [`INSERT INTO "AssetMeterReading" ("id", "tenantId", "assetId", "loanId", "readingDate", "value", "unit", "source") VALUES (gen_random_uuid()::text, $1, $2, $3, $4::date, $5, 'HOURS', 'STAFF')`,
            fx.tenantId, lease.device.assetId, lease.loanId, row.startDate, row.start],
          [`UPDATE "AssetFinanceDeal" SET "usageAllowancePerYear" = $2 WHERE "loanId" = $1`, lease.loanId, row.allowance])
        const [{ ceiling }] = await tx.$queryRawUnsafe<{ ceiling: number }[]>(`SELECT public."telematicsPaceCeiling"($1, $2, $3::date) AS ceiling`, fx.tenantId, lease.loanId, row.on)
        if (ceiling !== row.ceiling) throw new Error(`${JSON.stringify(row)}: SQL says ${ceiling}`)
      }
      await setup(tx, [`UPDATE "AssetFinanceDeal" SET "usageAllowancePerYear" = NULL, "usageUnit" = NULL, "excessRateCents" = NULL WHERE "loanId" = $1`, lease.loanId])
      const [{ none }] = await tx.$queryRawUnsafe<{ none: number | null }[]>(`SELECT public."telematicsPaceCeiling"($1, $2, CURRENT_DATE) AS none`, fx.tenantId, lease.loanId)
      if (none !== null) throw new Error(`no allowance: expected NULL, got ${none}`)
    })
  }, 120_000)
})
