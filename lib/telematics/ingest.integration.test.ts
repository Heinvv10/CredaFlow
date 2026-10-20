/**
 * Telematics ingest on real Postgres (docs/asset-finance/SLICE5.md part B):
 * idempotent per provider event id (a replayed batch and two concurrent
 * sweeps change nothing; the unique index is what makes it so), a lower or an
 * implausible meter value is held for staff and never written unattended,
 * and a staff accept or reject decides it.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/ingest.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "@/lib/asset-finance/dates"
import { ruleRefuses } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { ingestEvent } from "./ingest"
import { acceptHeldReading, rejectHeldReading } from "./held-readings"
import { getTelematicsProvider } from "./registry"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, loanStartDate } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { rollbackLoan: "", spikeLoan: "", rollbackDevice: "", spikeDevice: "", start: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` })
const counts = async (deviceId: string) => ({
  events: await database().telematicsEvent.count({ where: { deviceId } }),
  positions: await database().telematicsPosition.count({ where: { deviceId } }),
  readings: await database().assetMeterReading.count({ where: { telematicsEvent: { deviceId } } }),
  held: await database().telematicsHeldReading.count({ where: { event: { deviceId } } }),
})
const heldOf = (deviceId: string) => database().telematicsHeldReading.findFirstOrThrow({ where: { event: { deviceId } }, include: { event: true } })
/** Test setup inside an attack's transaction: the statements run with triggers off. */
async function setup(tx: Tx, ...statements: [string, ...unknown[]][]): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
  for (const [statement, ...params] of statements) await tx.$executeRawUnsafe(statement, ...params)
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin")
}
const LATER_READINGS = `DELETE FROM "AssetMeterReading" WHERE "loanId" = $1 AND "source" = 'TELEMATICS' AND "readingDate" > $2::date`
const telematicsReading = (tx: Tx, loanId: string, eventId: string, readingDate: string, value: number, recordedById: string | null = null) =>
  tx.assetMeterReading.create({ data: {
    tenantId: fx.tenantId, assetId: fx.assets[ids.rollbackLoan === loanId ? 1 : 2], loanId, readingDate: dbDate(readingDate), value, unit: "HOURS",
    source: "TELEMATICS", telematicsEventId: eventId, recordedById,
  } })

suite.sequential("telematics ingest: idempotent, lower and implausible readings held (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.rollbackLoan = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    ids.spikeLoan = await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    ids.start = await loanStartDate(database(), ids.rollbackLoan)
    expect(ids.start).toBe(daysAgo(30))
    ids.rollbackDevice = await installDevice(fx, fx.assets[1], "SIM-ROLLBACK-1", ids.start)
    ids.spikeDevice = await installDevice(fx, fx.assets[2], "SIM-SPIKE-1", ids.start)
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("stores a poll once: the same events again, and two sweeps at once, add nothing", async () => {
    const now = new Date()
    const first = await pollTenant(fx.tenantId, now)
    expect(first).toMatchObject({ ok: true, failed: 0, unknownDevices: 0 })
    expect(first.stored).toBeGreaterThan(80)
    const before = await counts(ids.rollbackDevice)
    expect(before.events).toBeGreaterThan(40)
    expect(before.positions).toBeGreaterThan(20)

    // The cursor moved on: re-polling at the same instant finds nothing new.
    expect(await pollTenant(fx.tenantId, now)).toMatchObject({ stored: 0, duplicates: 0, failed: 0 })
    // Replay the whole batch from scratch (cursor reset), twice at once.
    await database().trackerDevice.updateMany({ where: { tenantId: fx.tenantId }, data: { pollCursor: null } })
    const [a, b] = await Promise.all([pollTenant(fx.tenantId, now), pollTenant(fx.tenantId, now)])
    expect(a.stored + b.stored).toBe(0)
    expect(a.failed + b.failed).toBe(0)
    expect(a.duplicates).toBe(first.stored)
    expect(await counts(ids.rollbackDevice)).toEqual(before)
    const events = await database().telematicsEvent.findMany({ where: { deviceId: ids.rollbackDevice }, select: { simulated: true } })
    expect(events.every((e) => e.simulated)).toBe(true)
  }, 120_000)

  it("the provider-event unique index is what refuses a duplicate: without it the same event is stored twice", async () => {
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: ids.rollbackDevice } })
    const [replayed] = (await getTelematicsProvider("simulated")!.poll({ devices: [{ externalDeviceId: device.externalDeviceId, cursor: null, installedOn: ids.start }], now: new Date() })).events
    const replay = (tx: Tx) => ingestEvent(tx as never, device, replayed, { now: new Date(), simulated: true, retentionDays: 90 })
      .then((outcome) => { if (!outcome.stored) throw new Error("duplicate event (ON CONFLICT DO NOTHING)") })
    await ruleRefuses(database(), { index: "TelematicsEvent_tenantId_provider_providerEventId_key" }, /duplicate event/, replay)
  }, 120_000)

  it("holds the ROLLBACK reading (below an earlier one) and writes nothing for it; the database refuses it written directly", async () => {
    const held = await heldOf(ids.rollbackDevice)
    expect(held).toMatchObject({ reason: "LOWER", status: "HELD", value: 1_000 + 6 * 15 - 200, loanId: ids.rollbackLoan })
    expect(held.event.meterOutcome).toBe("HELD")
    expect(await database().assetMeterReading.count({ where: { telematicsEventId: held.eventId } })).toBe(0)
    const audit = await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TELEMATICS_READING_HELD", entityId: held.id } })
    expect(audit).toBe(1)
    await ruleRefuses(database(), { table: "AssetMeterReading", trigger: "AssetMeterReading_guard" }, /Meter readings are monotonic/,
      async (tx) => {
        await setup(tx, [`DELETE FROM "TelematicsHeldReading" WHERE "id" = $1`, held.id])
        await telematicsReading(tx, ids.rollbackLoan, held.eventId, held.readingDate.toISOString().slice(0, 10), held.value)
      })
  }, 120_000)

  it("a lower reading can never be accepted (422); it is rejected with a note", async () => {
    const held = await heldOf(ids.rollbackDevice)
    expect(await acceptHeldReading(officer(), held.id, {})).toMatchObject({
      kind: "refused", status: 422, error: expect.stringMatching(/a lower reading cannot be accepted; reject it or record a corrected reading with evidence/i),
    })
    expect(await rejectHeldReading(officer(), held.id, { note: "" })).toMatchObject({ kind: "refused", status: 400 })
    expect(await rejectHeldReading(officer(), held.id, { note: "Device rolled back; lease stays on staff readings" })).toMatchObject({ kind: "ok" })
    expect(await database().telematicsHeldReading.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ status: "REJECTED", decidedById: fx.officer, meterReadingId: null })
    expect(await rejectHeldReading(officer(), held.id, { note: "again" })).toMatchObject({ kind: "refused", status: 409 })
  }, 120_000)

  it("holds the SPIKE reading as implausible; the pace rule refuses it unattended; a staff accept writes it, vouched", async () => {
    const held = await heldOf(ids.spikeDevice)
    expect(held).toMatchObject({ reason: "IMPLAUSIBLE", status: "HELD", value: 1_000 + 6 * 10 + 50_000 })
    // Unattended, with the held row out of the way: only the pace clause stops it.
    await ruleRefuses(database(), { fn: "guardTelematicsMeterReading", replace: [`IF NEW."value" > public."telematicsPaceCeiling"`, `IF FALSE AND NEW."value" > public."telematicsPaceCeiling"`] },
      /may not run ahead of three times the contracted pace/,
      async (tx) => {
        await setup(tx, [LATER_READINGS, ids.spikeLoan, held.readingDate], [`DELETE FROM "TelematicsHeldReading" WHERE "id" = $1`, held.id])
        await telematicsReading(tx, ids.spikeLoan, held.eventId, held.readingDate.toISOString().slice(0, 10), held.value)
      })
    // A held event is never written unattended, and a staff-recorded one only as an accept.
    await ruleRefuses(database(), { fn: "guardTelematicsMeterReading", replace: [`IF EXISTS (SELECT 1 FROM "TelematicsHeldReading" h WHERE h."eventId" = NEW."telematicsEventId" AND h."tenantId" = NEW."tenantId") THEN`, `IF FALSE THEN`] },
      /written only by the staff member who accepts it/,
      async (tx) => {
        await setup(tx, [LATER_READINGS, ids.spikeLoan, held.readingDate], [`UPDATE "AssetFinanceDeal" SET "usageAllowancePerYear" = NULL, "usageUnit" = NULL, "excessRateCents" = NULL WHERE "loanId" = $1`, ids.spikeLoan])
        await telematicsReading(tx, ids.spikeLoan, held.eventId, held.readingDate.toISOString().slice(0, 10), held.value)
      })
    // Every later spike-free day was written, so accepting the spike now would break monotonicity: the accept refuses it.
    expect(await acceptHeldReading(officer(), held.id, {})).toMatchObject({
      kind: "refused", status: 422, error: expect.stringMatching(/above a later reading cannot be accepted; reject it or record a corrected reading with evidence/i),
    })
  }, 120_000)

  it("a staff accept of a held reading that still fits writes it, recorded by the accepter, and decides the hold", async () => {
    // A held SPIKE whose later readings are not yet written: a fresh lease and device, polled to day 10 only.
    const asset = fx.assets[3]
    const loan = await bookOperatingLease(database(), fx, setSession, asset)
    const start = await loanStartDate(database(), loan)
    const deviceId = await installDevice(fx, asset, "SIM-SPIKE-2", start)
    await pollTenant(fx.tenantId, new Date(`${daysAgo(20)}T18:00:00.000Z`))
    const held = await heldOf(deviceId)
    expect(held.reason).toBe("IMPLAUSIBLE")
    expect(await acceptHeldReading(officer(), held.id, { note: "Checked on site: the hour meter was replaced" })).toMatchObject({ kind: "ok" })
    const decided = await database().telematicsHeldReading.findUniqueOrThrow({ where: { id: held.id }, include: { meterReading: true } })
    expect(decided).toMatchObject({ status: "ACCEPTED", decidedById: fx.officer })
    expect(decided.meterReading).toMatchObject({ source: "TELEMATICS", recordedById: fx.officer, value: held.value, telematicsEventId: held.eventId })
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TELEMATICS_HELD_READING_ACCEPTED", entityId: held.id } })).toBe(1)
    expect(await acceptHeldReading(officer(), held.id, {})).toMatchObject({ kind: "refused", status: 409 })
  }, 300_000)
})
