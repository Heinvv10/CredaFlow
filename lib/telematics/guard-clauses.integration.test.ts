/**
 * Single guard clauses on real Postgres (docs/asset-finance/SLICE5.md part B),
 * each one the only thing refusing its attack (the test review of PR #222
 * found them surviving their mutation): an alert's event binding and times,
 * a held reading's unit, asset, lease type and decider, a TELEMATICS
 * reading's unit, lease and acceptance, the pace ceiling's unit, and a
 * device's registration and meter verification.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/guard-clauses.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient, TelematicsAlertKind, TelematicsEventKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "@/lib/asset-finance/dates"
import { ruleAdmits, ruleRefuses } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { ingestEvent } from "./ingest"
import { verifyTrackerMeter } from "./devices"
import { ceilingOn } from "./edge.integration-fixture"
import {
  alertEvent, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, eveningOf, installDevice, loanStartDate, meterEvent, telematicsTestClient,
} from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loanA: "", loanB: "", deviceA: "", deviceB: "", startA: "", spike: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const fn = (name: string, clause: string, replacement = "") => ({ fn: name, replace: [clause, replacement] as const })
const event = (tx: Tx, kind: TelematicsEventKind, over: Record<string, unknown> = {}) => tx.telematicsEvent.create({ data: {
  tenantId: fx.tenantId, deviceId: ids.deviceA, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind, occurredAt: new Date(Date.now() - 60_000), simulated: true, ...over,
} })
const alert = (tx: Tx, eventId: string, at: Date, over: Record<string, unknown> = {}) => tx.telematicsAlert.create({ data: {
  tenantId: fx.tenantId, eventId, deviceId: ids.deviceA, assetId: fx.assets[1], loanId: ids.loanA, kind: "POWER_CUT", queue: "SERVICING", firstOccurredAt: at, lastOccurredAt: at, ...over,
} })
const ingest = async (deviceId: string, e: ReturnType<typeof meterEvent>) => {
  const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: deviceId } })
  return database().$transaction((tx) => ingestEvent(tx as never, device, e, { now: new Date(), simulated: true, retentionDays: 90 }))
}
const replica = (tx: Tx, on: boolean) => tx.$executeRawUnsafe(`SET LOCAL session_replication_role = ${on ? "replica" : "origin"}`)
const offDeferred = (tx: Tx) => tx.$executeRawUnsafe(`ALTER TABLE "AssetMeterReading" DISABLE TRIGGER "AssetMeterReading_telematics_accepted"`)

suite.sequential("telematics single guard clauses (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    const setSession = (user: SessionUser | null) => { session.current = user && { user } }
    ids.loanA = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    ids.loanB = await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    ids.startA = await loanStartDate(database(), ids.loanA)
    ids.deviceA = await installDevice(fx, fx.assets[1], "SIM-STEADY-81", daysAgo(30))
    ids.deviceB = await installDevice(fx, fx.assets[2], "SIM-STEADY-82", daysAgo(30))
    // A held IMPLAUSIBLE reading on lease A, with no later reading: it fits monotonically.
    const spike = await ingest(ids.deviceA, meterEvent("SIM-STEADY-81", eveningOf(daysAgo(10)), ceilingOn(ids.startA, daysAgo(10)) + 1_000))
    expect(spike).toMatchObject({ meterOutcome: "HELD" })
    ids.spike = (await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: ids.loanA } })).id
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("stores a position only inside a running loan's tenure: begun, and not overtaken by a later loan on the asset", async () => {
    const G = "telematicsLoanAt"
    const TENURE = /stored only while a running agreement on its asset covers its time/
    const store = async (tx: Tx) => {
      const e = await event(tx, "POSITION")
      await tx.telematicsPosition.deleteMany({ where: { deviceId: ids.deviceA } })
      await tx.telematicsPosition.create({ data: { tenantId: fx.tenantId, eventId: e.id, deviceId: ids.deviceA, occurredAt: e.occurredAt, latitude: -35.01, longitude: 20.01 } })
    }
    const withTriggersOff = async (tx: Tx, sql: string, ...params: unknown[]) => {
      await replica(tx, true)
      await tx.$executeRawUnsafe(sql, ...params)
      await replica(tx, false)
    }
    await ruleRefuses(database(), fn(G, `
    AND (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= (at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date`), TENURE, async (tx) => {
      await withTriggersOff(tx, `UPDATE "Loan" SET "startDate" = now() + INTERVAL '2 days' WHERE "id" = $1`, ids.loanA)
      await store(tx)
    })
    // A later loan on the asset (a copy, since closed) started yesterday: lease A's tenure ended then.
    await ruleRefuses(database(), fn(G, `FROM "Loan" n WHERE n."tenantId"`, `FROM "Loan" n WHERE FALSE AND n."tenantId"`), TENURE, async (tx) => {
      await withTriggersOff(tx, `INSERT INTO "LoanApplication" SELECT (jsonb_populate_record(NULL::"LoanApplication", to_jsonb(a) || jsonb_build_object('id', $2::text, 'reference', $2::text))).*
        FROM "LoanApplication" a WHERE a."id" = (SELECT "applicationId" FROM "Loan" WHERE "id" = $1)`, ids.loanA, `nextapp_${t}`)
      await withTriggersOff(tx, `INSERT INTO "Loan" SELECT (jsonb_populate_record(NULL::"Loan", to_jsonb(l) || jsonb_build_object('id', $2::text, 'reference', $2::text, 'applicationId', $3::text,
          'status', 'COMPLETED', 'startDate', now() - INTERVAL '1 day'))).* FROM "Loan" l WHERE l."id" = $1`, ids.loanA, `next_${t}`, `nextapp_${t}`)
      await store(tx)
    })
  }, 120_000)

  it("raises an alert only from its event's device, asset and kind, at its time; a repeat never moves the last occurrence back", async () => {
    const G = "guardTelematicsAlert"
    const BOUND = /raised by an alert event of its kind, on its device and asset/
    const fresh = async (tx: Tx, kind: TelematicsAlertKind = "POWER_CUT") => event(tx, "ALERT", { alertKind: kind })
    await ruleRefuses(database(), fn(G, ` OR ev."deviceId" <> NEW."deviceId"`), BOUND, async (tx) => {
      const e = await fresh(tx)
      await alert(tx, e.id, e.occurredAt, { deviceId: ids.deviceB })
    })
    await ruleRefuses(database(), fn(G, ` OR ev."assetId" <> NEW."assetId"`), BOUND, async (tx) => {
      const e = await fresh(tx)
      await alert(tx, e.id, e.occurredAt, { assetId: fx.assets[2] })
    })
    await ruleRefuses(database(), fn(G, ` OR ev."alertKind" <> NEW."kind"`), BOUND, async (tx) => {
      const e = await fresh(tx, "TAMPER")
      await alert(tx, e.id, e.occurredAt)
    })
    const AT = /raised OPEN, once, at its event's time/
    await ruleRefuses(database(), fn(G, ` OR NEW."firstOccurredAt" <> ev."occurredAt"`), AT, async (tx) => {
      const e = await fresh(tx)
      await alert(tx, e.id, e.occurredAt, { firstOccurredAt: new Date(e.occurredAt.getTime() - 60_000) })
    })
    await ruleRefuses(database(), fn(G, ` OR NEW."lastOccurredAt" <> ev."occurredAt"`), AT, async (tx) => {
      const e = await fresh(tx)
      await alert(tx, e.id, e.occurredAt, { lastOccurredAt: new Date(e.occurredAt.getTime() + 60_000) })
    })
    const t1 = new Date(Date.now() - 3_600_000)
    const raised = await ingest(ids.deviceA, alertEvent("SIM-STEADY-81", t1, "GEOFENCE_EXIT"))
    await ingest(ids.deviceA, alertEvent("SIM-STEADY-81", new Date(t1.getTime() + 600_000), "GEOFENCE_EXIT"))
    const id = (raised as { alertId: string }).alertId
    await ruleRefuses(database(), fn(G, ` AND NEW."lastOccurredAt" >= OLD."lastOccurredAt"`), /never moves the last occurrence back/,
      (tx) => tx.telematicsAlert.update({ where: { id }, data: { occurrences: 3, lastOccurredAt: new Date(t1.getTime() + 60_000) } }))
  }, 120_000)

  it("holds a reading only in its event's unit, on its event's asset, for an operating or full-maintenance lease; accepted only as its decider's own reading", async () => {
    const G = "guardTelematicsHeldReading"
    const BOUND = /its meter event's value, unit, SAST date and asset, for a lease of that asset/
    const day = daysAgo(3)
    const held = async (tx: Tx, over: Record<string, unknown>, meter: Record<string, unknown> = {}) => {
      const e = await event(tx, "METER", { meterValue: 1_500, meterUnit: "HOURS", occurredAt: eveningOf(day), ...meter })
      await tx.telematicsHeldReading.create({ data: {
        tenantId: fx.tenantId, eventId: e.id, loanId: ids.loanA, assetId: fx.assets[1], readingDate: dbDate(day), value: 1_500, unit: "HOURS", reason: "IMPLAUSIBLE", ...over,
      } })
    }
    await ruleAdmits(database(), (tx) => held(tx, {}))
    await ruleRefuses(database(), fn(G, ` OR ev."meterUnit" <> NEW."unit"`), BOUND, (tx) => held(tx, {}, { meterUnit: "KM" }))
    await ruleRefuses(database(), fn(G, ` OR ev."assetId" <> NEW."assetId"`), BOUND, (tx) => held(tx, { assetId: fx.assets[2], loanId: ids.loanB }))
    await ruleRefuses(database(), fn(G, `
         AND l."contractType"::text IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')`), BOUND, async (tx) => {
      await replica(tx, true)
      await tx.$executeRawUnsafe(`UPDATE "Loan" SET "contractType" = 'INSTALMENT_SALE', "cpaApplies" = NULL, "cpaRule" = NULL WHERE "id" = $1`, ids.loanA)
      await replica(tx, false)
      await held(tx, {})
    })
    const spike = await database().telematicsHeldReading.findUniqueOrThrow({ where: { id: ids.spike } })
    await ruleRefuses(database(), fn(G, ` AND m."recordedById" = NEW."decidedById"`), /the reading its decider recorded from its event/, async (tx) => {
      const reading = await tx.assetMeterReading.create({ data: {
        tenantId: fx.tenantId, assetId: fx.assets[1], loanId: ids.loanA, readingDate: spike.readingDate, value: spike.value, unit: "HOURS", source: "TELEMATICS",
        telematicsEventId: spike.eventId, recordedById: fx.adminA,
      } })
      await tx.telematicsHeldReading.update({ where: { id: spike.id }, data: { status: "ACCEPTED", decidedById: fx.officer, decidedAt: new Date(), decisionNote: "Synthetic", meterReadingId: reading.id } })
    })
  }, 120_000)

  it("writes a staff TELEMATICS reading only as the acceptance of its own lease's held reading, decided in the same transaction", async () => {
    const G = "guardTelematicsMeterReading"
    const spike = await database().telematicsHeldReading.findUniqueOrThrow({ where: { id: ids.spike } })
    const staffReading = (tx: Tx) => tx.assetMeterReading.create({ data: {
      tenantId: fx.tenantId, assetId: fx.assets[1], loanId: ids.loanA, readingDate: spike.readingDate, value: spike.value, unit: "HOURS", source: "TELEMATICS",
      telematicsEventId: spike.eventId, recordedById: fx.officer,
    } })
    // The hold names another lease (written with the guards off): the staff reading is not its acceptance.
    await ruleRefuses(database(), fn(G, ` AND h."loanId" = NEW."loanId"`), /is the acceptance of a held reading of its lease/, async (tx) => {
      await offDeferred(tx)
      await replica(tx, true)
      await tx.$executeRawUnsafe(`UPDATE "TelematicsHeldReading" SET "loanId" = $2 WHERE "id" = $1`, spike.id, ids.loanB)
      await replica(tx, false)
      await staffReading(tx)
    })
    // The reading written, the hold left HELD: refused when the transaction's deferred checks run.
    await ruleRefuses(database(), { table: "AssetMeterReading", trigger: "AssetMeterReading_telematics_accepted" },
      /decided as its held reading's acceptance in the same transaction/, staffReading)
    // A TELEMATICS reading in another unit than its event's.
    await ruleRefuses(database(), fn(G, ` OR ev."meterUnit" <> NEW."unit"`), /its meter event's value, unit, SAST date and asset/, async (tx) => {
      const e = await event(tx, "METER", { meterValue: 1_010, meterUnit: "KM", occurredAt: eveningOf(daysAgo(20)) })
      await tx.assetMeterReading.create({ data: {
        tenantId: fx.tenantId, assetId: fx.assets[1], loanId: ids.loanA, readingDate: dbDate(daysAgo(20)), value: 1_010, unit: "HOURS", source: "TELEMATICS", telematicsEventId: e.id,
      } })
    })
  }, 120_000)

  it("measures the pace ceiling from the lease's start reading in its own unit, whatever else is on file", async () => {
    const day = daysAgo(5)
    // A KM reading dated at the start, lower than every HOURS one, is not the start reading (mutation-checked: without the unit clause it is).
    await ruleAdmits(database(), async (tx) => {
      await replica(tx, true)
      await tx.$executeRawUnsafe(`INSERT INTO "AssetMeterReading" ("id", "tenantId", "assetId", "loanId", "readingDate", "value", "unit", "source")
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4::date, 10, 'KM', 'STAFF')`, fx.tenantId, fx.assets[1], ids.loanA, ids.startA)
      await replica(tx, false)
      const [{ ceiling }] = await tx.$queryRawUnsafe<{ ceiling: number }[]>(`SELECT public."telematicsPaceCeiling"($1, $2, $3::date) AS ceiling`, fx.tenantId, ids.loanA, day)
      if (ceiling !== ceilingOn(ids.startA, day)) throw new Error(`the ceiling is not the HOURS start reading's: ${ceiling}`)
    })
  }, 120_000)

  it("registers a device ACTIVE and unverified; its meter verification is a note, set once", async () => {
    const D = "guardTrackerDevice"
    const create = (tx: Tx, over: Record<string, unknown>) => tx.trackerDevice.create({ data: {
      tenantId: fx.tenantId, assetId: fx.assets[3], provider: "simulated", externalDeviceId: `SIM-STEADY-${randomUUID().slice(0, 4)}`, installedOn: dbDate(daysAgo(1)), createdById: fx.officer, ...over,
    } })
    await ruleRefuses(database(), fn(D, `NEW."status" <> 'ACTIVE' OR `), /registered ACTIVE and unverified/,
      (tx) => create(tx, { status: "REMOVED", removedOn: dbDate(daysAgo(1)), removedById: fx.officer }))
    await ruleRefuses(database(), fn(D, ` OR NEW."meterVerifiedAt" IS NOT NULL`), /registered ACTIVE and unverified/,
      (tx) => create(tx, { meterVerifiedAt: new Date(), meterVerifiedById: fx.officer, meterVerifiedNote: "At registration" }))
    await ruleRefuses(database(), { table: "TrackerDevice", constraint: "TrackerDevice_meter_verified_shape" }, /TrackerDevice_meter_verified_shape/,
      (tx) => tx.trackerDevice.update({ where: { id: ids.deviceB }, data: { meterVerifiedAt: new Date(), meterVerifiedById: fx.officer, meterVerifiedNote: " " } }))
    const actor = { tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` }
    expect(await verifyTrackerMeter(actor, ids.deviceB, { note: "Dashboard and device agree" })).toMatchObject({ kind: "ok" })
    await ruleRefuses(database(), fn(D, `IF OLD."meterVerifiedAt" IS NOT NULL AND (`, `IF FALSE AND (`), /meter verification is set once/,
      (tx) => tx.trackerDevice.update({ where: { id: ids.deviceB }, data: { meterVerifiedNote: "Rewritten later" } }))
  }, 120_000)
})
