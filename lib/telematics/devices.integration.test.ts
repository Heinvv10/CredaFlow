/**
 * Tracker devices on real Postgres (docs/asset-finance/SLICE5.md part B): one
 * live device per asset and per provider device id, a registered provider, a
 * fixed identity, removal once and for good, never deleted, and no event for
 * a removed device. Each rule refuses its attack and is what refuses it.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/devices.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "@/lib/asset-finance/dates"
import { ruleAdmits, ruleRefuses } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import { registerTrackerDevice, removeTrackerDevice, trackerHeartbeat } from "./devices"
import { cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient, today } from "./telematics.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let deviceId = ""
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const G = { table: "TrackerDevice", trigger: "TrackerDevice_guard" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` })
const device = (tx: Tx, assetId: string, externalDeviceId: string, over: Record<string, unknown> = {}) => tx.trackerDevice.create({ data: {
  tenantId: fx.tenantId, assetId, provider: "simulated", externalDeviceId, installedOn: dbDate(daysAgo(3)), createdById: fx.officer, ...over,
} })

suite.sequential("tracker devices (real DB)", () => {
  beforeAll(async () => {
    fx = await createTelematicsFixture(database(), t)
    deviceId = await installDevice(fx, fx.assets[0], "SIM-STEADY-1", daysAgo(10))
  }, 300_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("registers a registered provider's well-formed device, installed by today, audited; refuses the rest with reasons", async () => {
    const register = (body: Record<string, unknown>, assetId = fx.assets[1]) => registerTrackerDevice(officer(), assetId, { provider: "simulated", externalDeviceId: "SIM-TAMPER-2", installedOn: today(), ...body })
    expect(await register({ provider: "acme-trackers" })).toMatchObject({ kind: "refused", status: 422, fields: { provider: expect.any(String) } })
    expect(await register({ externalDeviceId: "TRK-1" })).toMatchObject({ kind: "refused", status: 422, fields: { externalDeviceId: expect.stringMatching(/SIM-<SCENARIO>-<n>/) } })
    expect(await register({ installedOn: daysAgo(-1) })).toMatchObject({ kind: "refused", status: 422, fields: { installedOn: expect.any(String) } })
    // A deployed build that does not name simulated-telematics refuses the simulator.
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-collections")
    expect(await register({})).toMatchObject({ kind: "refused", status: 422, error: expect.stringMatching(/not permitted on a deployed build/) })
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-telematics")
    expect(await register({}, "not-an-asset")).toMatchObject({ kind: "refused", status: 404 })
    vi.unstubAllEnvs()
    expect(await register({}, "not-an-asset")).toMatchObject({ kind: "refused", status: 404 })
    expect(await register({}, fx.assets[0])).toMatchObject({ kind: "refused", status: 409 })
    expect(await register({ externalDeviceId: "SIM-STEADY-1" })).toMatchObject({ kind: "refused", status: 409 })
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TRACKER_DEVICE_REGISTERED" } })).toBe(1)
    expect(await trackerHeartbeat(fx.tenantId, fx.assets[0])).toMatchObject({ deviceId, provider: "simulated", simulated: true, lastSeenAt: null, matchesTrackerId: false })
  }, 120_000)

  it("keeps one live device per asset and per provider device id", async () => {
    await ruleRefuses(database(), { index: "TrackerDevice_one_active_per_asset" }, /Unique constraint failed/, (tx) => device(tx, fx.assets[0], "SIM-STEADY-2"))
    await ruleRefuses(database(), { index: "TrackerDevice_one_active_per_external_id" }, /Unique constraint failed/, (tx) => device(tx, fx.assets[1], "SIM-STEADY-1"))
  }, 120_000)

  it("checks the provider key, the device id and the removal shape", async () => {
    await ruleRefuses(database(), { table: "TrackerDevice", constraint: "TrackerDevice_provider_key" }, /TrackerDevice_provider_key/,
      (tx) => device(tx, fx.assets[1], "SIM-STEADY-3", { provider: "Not A Key" }))
    await ruleRefuses(database(), { table: "TrackerDevice", constraint: "TrackerDevice_external_id" }, /TrackerDevice_external_id/,
      (tx) => device(tx, fx.assets[1], "   "))
    await ruleRefuses(database(), { table: "TrackerDevice", constraint: "TrackerDevice_status_shape" }, /TrackerDevice_status_shape/,
      (tx) => tx.trackerDevice.update({ where: { id: deviceId }, data: { status: "REMOVED", removedOn: dbDate(today()) } }))
  }, 120_000)

  it("fixes a device's identity; is registered ACTIVE by today; removed once, between installation and today; final; never deleted", async () => {
    await ruleRefuses(database(), G, /installed no later than today/, (tx) => device(tx, fx.assets[1], "SIM-STEADY-4", { installedOn: dbDate(daysAgo(-2)) }))
    await ruleRefuses(database(), G, /device id, installation date and creator are fixed/, (tx) => tx.trackerDevice.update({ where: { id: deviceId }, data: { externalDeviceId: "SIM-STEADY-5" } }))
    await ruleRefuses(database(), G, /device id, installation date and creator are fixed/, (tx) => tx.trackerDevice.update({ where: { id: deviceId }, data: { assetId: fx.assets[2] } }))
    await ruleRefuses(database(), G, /between its installation and today/,
      (tx) => tx.trackerDevice.update({ where: { id: deviceId }, data: { status: "REMOVED", removedOn: dbDate(daysAgo(11)), removedById: fx.officer } }))
    await ruleRefuses(database(), G, /never deleted/, (tx) => tx.trackerDevice.delete({ where: { id: deviceId } }))

    expect(await removeTrackerDevice(officer(), deviceId, { removedOn: daysAgo(11) })).toMatchObject({ kind: "refused", status: 422 })
    expect(await removeTrackerDevice(officer(), deviceId, { removedOn: today() })).toMatchObject({ kind: "ok" })
    expect(await removeTrackerDevice(officer(), deviceId, { removedOn: today() })).toMatchObject({ kind: "refused", status: 409 })
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TRACKER_DEVICE_REMOVED", entityId: deviceId } })).toBe(1)
    await ruleRefuses(database(), G, /A removed tracker device is final/,
      (tx) => tx.trackerDevice.update({ where: { id: deviceId }, data: { status: "ACTIVE", removedOn: null, removedById: null } }))
    await ruleRefuses(database(), G, /A removed tracker device is final/, (tx) => tx.trackerDevice.update({ where: { id: deviceId }, data: { pollCursor: "x" } }))
    // A new device may now be fitted to the asset.
    expect(await registerTrackerDevice(officer(), fx.assets[0], { provider: "simulated", externalDeviceId: "SIM-STEADY-1", installedOn: today() })).toMatchObject({ kind: "ok" })
  }, 120_000)

  it("stores no event for a removed device, nor under another provider, nor before its installation", async () => {
    const E = { table: "TelematicsEvent", trigger: "TelematicsEvent_guard" }
    const event = (tx: Tx, over: Record<string, unknown>) => tx.telematicsEvent.create({ data: {
      tenantId: fx.tenantId, deviceId, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind: "HEARTBEAT", occurredAt: new Date(), simulated: true, ...over,
    } })
    await ruleRefuses(database(), E, /of an active device of the tenant/, (tx) => event(tx, {}))
    const live = await database().trackerDevice.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "ACTIVE" } })
    await ruleRefuses(database(), E, /of an active device of the tenant/, (tx) => event(tx, { deviceId: live.id, provider: "other-provider" }))
    await ruleRefuses(database(), E, /between the device's installation and now/, (tx) => event(tx, { deviceId: live.id, occurredAt: new Date(Date.now() - 3 * 86_400_000) }))
    await ruleRefuses(database(), E, /between the device's installation and now \(not yet\)/, (tx) => event(tx, { deviceId: live.id, occurredAt: new Date(Date.now() + 3_600_000) }))
    // Older than the tenant's retention: a purged event delivered again is not stored as new (retention 1 day here).
    await ruleRefuses(database(), { fn: "guardTelematicsEvent", replace: [`IF NOT COALESCE(NEW."occurredAt" >= (now() AT TIME ZONE 'UTC') - make_interval(days => retention), FALSE) THEN`, "IF FALSE THEN"] },
      /older than the tenant's retention is not stored/, async (tx) => {
        await tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 1 } })
        const earlier = await device(tx, fx.assets[2], "SIM-STEADY-8", { installedOn: dbDate(daysAgo(5)) })
        await event(tx, { deviceId: earlier.id, occurredAt: new Date(Date.now() - 2 * 86_400_000) })
      })
    await ruleRefuses(database(), E, /outcome is set after the event is stored/, (tx) => event(tx, { deviceId: live.id, kind: "METER", meterValue: 1, meterUnit: "HOURS", meterOutcome: "SAME_DAY" }))
    await ruleRefuses(database(), { table: "TelematicsEvent", constraint: "TelematicsEvent_kind_shape" }, /TelematicsEvent_kind_shape/,
      (tx) => event(tx, { deviceId: live.id, meterValue: 1, meterUnit: "HOURS" }))
  }, 120_000)

  it("keeps the retry counter whole: an event id with a count, or neither", async () => {
    const live = await database().trackerDevice.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "ACTIVE" } })
    const SHAPE = { table: "TrackerDevice", constraint: "TrackerDevice_failing_event_shape" }
    await ruleAdmits(database(), (tx) => tx.trackerDevice.update({ where: { id: live.id }, data: { failingEventId: "e-1", failingEventCount: 2 } }))
    await ruleRefuses(database(), SHAPE, /TrackerDevice_failing_event_shape/, (tx) => tx.trackerDevice.update({ where: { id: live.id }, data: { failingEventId: "e-1", failingEventCount: 0 } }))
    await ruleRefuses(database(), SHAPE, /TrackerDevice_failing_event_shape/, (tx) => tx.trackerDevice.update({ where: { id: live.id }, data: { failingEventId: null, failingEventCount: 1 } }))
    await ruleRefuses(database(), SHAPE, /TrackerDevice_failing_event_shape/, (tx) => tx.trackerDevice.update({ where: { id: live.id }, data: { failingEventId: "e-1", failingEventCount: -1 } }))
  }, 120_000)

  it("keeps only a heartbeat when no agreement covers the event (this asset has none)", async () => {
    const live = await database().trackerDevice.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "ACTIVE" } })
    const event = (tx: Tx, over: Record<string, unknown>) => tx.telematicsEvent.create({ data: {
      tenantId: fx.tenantId, deviceId: live.id, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind: "HEARTBEAT", occurredAt: new Date(Date.now() - 60_000), simulated: true, ...over,
    } })
    await ruleAdmits(database(), (tx) => event(tx, {}))
    const NO_AGREEMENT = { fn: "guardTelematicsEvent", replace: [`IF NEW."kind" <> 'HEARTBEAT' AND public."telematicsLoanAt"(`, `IF FALSE AND public."telematicsLoanAt"(`] } as const
    for (const over of [{ kind: "METER", meterValue: 1_000, meterUnit: "HOURS" }, { kind: "ALERT", alertKind: "TAMPER" }, { kind: "IGNITION", ignitionOn: true }, { kind: "POSITION" }]) {
      await ruleRefuses(database(), NO_AGREEMENT, /With no agreement covering it only a heartbeat event is stored/, (tx) => event(tx, over))
    }
  }, 120_000)
})
