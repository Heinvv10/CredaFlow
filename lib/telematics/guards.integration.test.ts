/**
 * The remaining telematics guard clauses on real Postgres (docs/asset-finance/
 * SLICE5.md part B): an event's immutability and outcome consistency, a
 * position's binding and immutability, a held reading's binding, decision and
 * lifecycle, an alert's raise shape, loan and acknowledgement, the access
 * log's binding, the CHECKs no other suite reaches, and TRUNCATE of the tables
 * no other suite truncates. Each refuses its
 * attack and is what refuses it (removed, the attack goes through).
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/guards.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient, TelematicsEventKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { attempt, ruleRefuses } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { acknowledgeAlert } from "./alerts"
import { rejectHeldReading } from "./held-readings"
import { alertEvent, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"
import { ingestEvent } from "./ingest"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loanA: "", loanB: "", deviceA: "", deviceB: "", held: "", rejected: "", alert: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const trigger = (table: string) => ({ table, trigger: `${table}_guard` })

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` })
const event = (tx: Tx, kind: TelematicsEventKind, over: Record<string, unknown> = {}) => tx.telematicsEvent.create({ data: {
  tenantId: fx.tenantId, deviceId: ids.deviceA, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind, occurredAt: new Date(), simulated: true,
  ...(kind === "METER" ? { meterValue: 2_000, meterUnit: "HOURS" as const } : {}), ...over,
} })
const held = (id: string) => database().telematicsHeldReading.findUniqueOrThrow({ where: { id } })

suite.sequential("telematics guards: events, positions, held readings, alerts, access log (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.loanA = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    ids.loanB = await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    ids.deviceA = await installDevice(fx, fx.assets[1], "SIM-ROLLBACK-1", daysAgo(30))
    ids.deviceB = await installDevice(fx, fx.assets[2], "SIM-ROLLBACK-2", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    ids.held = (await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: ids.loanA } })).id
    ids.rejected = (await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: ids.loanB } })).id
    expect(await rejectHeldReading(officer(), ids.rejected, { note: "Synthetic rejection" })).toMatchObject({ kind: "ok" })
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: ids.deviceA } })
    const raised = await database().$transaction((tx) => ingestEvent(tx as never, device, alertEvent(device.externalDeviceId, new Date(), "TAMPER"), { now: new Date(), simulated: true, retentionDays: 90 }))
    ids.alert = (raised as { alertId: string }).alertId
    expect(await acknowledgeAlert(officer(), ids.alert)).toMatchObject({ kind: "ok" })
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("keeps an event immutable but for its meter outcome, set once and true to what was written", async () => {
    const recorded = await database().telematicsEvent.findFirstOrThrow({ where: { deviceId: ids.deviceA, meterOutcome: "RECORDED" } })
    const IMMUTABLE = /immutable but for a meter event's outcome, set once/
    await ruleRefuses(database(), trigger("TelematicsEvent"), IMMUTABLE, (tx) => tx.telematicsEvent.update({ where: { id: recorded.id }, data: { occurredAt: new Date(recorded.occurredAt.getTime() - 60_000) } }))
    await ruleRefuses(database(), trigger("TelematicsEvent"), IMMUTABLE, (tx) => tx.telematicsEvent.update({ where: { id: recorded.id }, data: { meterOutcome: "SAME_DAY" } }))
    await ruleRefuses(database(), { fn: "guardTelematicsEvent", replace: [`IF (NEW."meterOutcome" = 'RECORDED') <> EXISTS (`, `IF FALSE AND (NEW."meterOutcome" = 'RECORDED') <> EXISTS (`] },
      /RECORDED exactly when its reading is written/, async (tx) => {
        const fresh = await event(tx, "METER")
        await tx.telematicsEvent.update({ where: { id: fresh.id }, data: { meterOutcome: "RECORDED" } })
      })
    await ruleRefuses(database(), { table: "TelematicsEvent", constraint: "TelematicsEvent_provider_event_id" }, /TelematicsEvent_provider_event_id/,
      (tx) => event(tx, "HEARTBEAT", { providerEventId: "" }))
  }, 120_000)

  it("binds a position to its position or alert event, within range, and never changes it", async () => {
    const position = await database().telematicsPosition.findFirstOrThrow({ where: { deviceId: ids.deviceA } })
    await ruleRefuses(database(), trigger("TelematicsPosition"), /its position or alert event's, on that event's device at its time/, async (tx) => {
      const heartbeat = await event(tx, "HEARTBEAT")
      await tx.telematicsPosition.create({ data: { tenantId: fx.tenantId, eventId: heartbeat.id, deviceId: ids.deviceA, occurredAt: heartbeat.occurredAt, latitude: -35.01, longitude: 20.01 } })
    })
    await ruleRefuses(database(), trigger("TelematicsPosition"), /never changed/, (tx) => tx.telematicsPosition.update({ where: { id: position.id }, data: { latitude: -34 } }))
    await ruleRefuses(database(), { table: "TelematicsPosition", constraint: "TelematicsPosition_range" }, /TelematicsPosition_range/, async (tx) => {
      const fresh = await event(tx, "POSITION")
      await tx.telematicsPosition.create({ data: { tenantId: fx.tenantId, eventId: fresh.id, deviceId: ids.deviceA, occurredAt: fresh.occurredAt, latitude: 91, longitude: 20 } })
    })
  }, 120_000)

  it("creates a held reading HELD from its meter event, decides it once, with a note to reject and the decider's own reading to accept", async () => {
    const H = trigger("TelematicsHeldReading")
    const base = await held(ids.held)
    const create = (over: Record<string, unknown>) => async (tx: Tx) => {
      const fresh = await event(tx, "METER", { meterValue: base.value })
      await tx.telematicsHeldReading.create({ data: {
        tenantId: fx.tenantId, eventId: fresh.id, loanId: ids.loanA, assetId: fx.assets[1], readingDate: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`), value: base.value, unit: "HOURS", reason: "LOWER",
        ...over,
      } })
    }
    const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10) // SAST
    await ruleRefuses(database(), H, /its meter event's value, unit, SAST date and asset/, create({ value: base.value + 1, readingDate: new Date(`${today}T00:00:00.000Z`) }))
    await ruleRefuses(database(), { fn: "guardTelematicsHeldReading", replace: [`OR NOT EXISTS (SELECT 1 FROM "Loan" l`, `OR FALSE AND NOT EXISTS (SELECT 1 FROM "Loan" l`] },
      /for a lease of that asset/, create({ loanId: ids.loanB, readingDate: new Date(`${today}T00:00:00.000Z`) }))
    await ruleRefuses(database(), H, /created HELD/, create({ readingDate: new Date(`${today}T00:00:00.000Z`), status: "REJECTED", decidedById: fx.officer, decidedAt: new Date(), decisionNote: "Synthetic" }))
    await ruleRefuses(database(), H, /A decided held reading is final/, (tx) => tx.telematicsHeldReading.update({ where: { id: ids.rejected }, data: { decisionNote: "Changed afterwards" } }))
    await ruleRefuses(database(), H, /event, lease, date, value and reason are fixed/, (tx) => tx.telematicsHeldReading.update({ where: { id: ids.held }, data: { value: base.value + 500 } }))
    const startReading = await database().assetMeterReading.findFirstOrThrow({ where: { loanId: ids.loanA, source: "STAFF" } })
    await ruleRefuses(database(), H, /the reading its decider recorded from its event/, (tx) => tx.telematicsHeldReading.update({ where: { id: ids.held }, data: {
      status: "ACCEPTED", decidedById: fx.officer, decidedAt: new Date(), meterReadingId: startReading.id,
    } }))
    await ruleRefuses(database(), H, /never deleted/, (tx) => tx.telematicsHeldReading.delete({ where: { id: ids.held } }))
    await ruleRefuses(database(), { table: "TelematicsHeldReading", constraint: "TelematicsHeldReading_decision_shape" }, /TelematicsHeldReading_decision_shape/,
      (tx) => tx.telematicsHeldReading.update({ where: { id: ids.held }, data: { status: "REJECTED", decidedById: fx.officer, decidedAt: new Date() } }))
  }, 120_000)

  it("raises an alert OPEN once on its asset's loan, and never changes an acknowledgement", async () => {
    const A = trigger("TelematicsAlert")
    const raise = (over: Record<string, unknown>) => async (tx: Tx) => {
      const fresh = await event(tx, "ALERT", { alertKind: "POWER_CUT" })
      await tx.telematicsAlert.create({ data: {
        tenantId: fx.tenantId, eventId: fresh.id, deviceId: ids.deviceA, assetId: fx.assets[1], loanId: ids.loanA, kind: "POWER_CUT", queue: "COLLECTIONS",
        firstOccurredAt: fresh.occurredAt, lastOccurredAt: fresh.occurredAt, ...over,
      } })
    }
    await ruleRefuses(database(), A, /alert's loan is on its asset/, raise({ loanId: ids.loanB }))
    await ruleRefuses(database(), A, /raised OPEN, once, at its event's time/, raise({ occurrences: 2 }))
    await ruleRefuses(database(), A, /An acknowledgement is not changed/, (tx) => tx.telematicsAlert.update({ where: { id: ids.alert }, data: { acknowledgedById: fx.adminA } }))
  }, 120_000)

  it("logs a position view only for a loan on its asset and a device of that asset", async () => {
    await ruleRefuses(database(), trigger("TelematicsPositionAccess"), /names a loan on its asset and a device of that asset/,
      (tx) => tx.telematicsPositionAccess.create({ data: { tenantId: fx.tenantId, userId: fx.officer, loanId: ids.loanA, assetId: fx.assets[1], deviceId: ids.deviceB, context: "RECOVERY" } }))
    await ruleRefuses(database(), trigger("TelematicsPositionAccess"), /names a loan on its asset and a device of that asset/,
      (tx) => tx.telematicsPositionAccess.create({ data: { tenantId: fx.tenantId, userId: fx.officer, loanId: ids.loanA, assetId: fx.assets[2], deviceId: null, context: "RECOVERY" } }))
  }, 120_000)

  it("refuses TRUNCATE of the device, event, held-reading and alert tables by each one's own trigger", async () => {
    const messages: Record<string, RegExp> = {
      TrackerDevice: /never deleted; it is removed/, TelematicsEvent: /deleted only by the purge/,
      TelematicsHeldReading: /held telematics reading is never deleted/, TelematicsAlert: /alert is never deleted; it is resolved/,
    }
    for (const [table, message] of Object.entries(messages)) {
      const truncate = (tx: Tx) => tx.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`)
      expect(await attempt(database(), truncate), table).toMatch(message)
      // the table's own trigger is the one that refused: without it, the refusal (if any) is another table's
      expect(await attempt(database(), truncate, { table, trigger: `${table}_no_truncate` }), table).not.toMatch(message)
    }
  }, 120_000)
})
