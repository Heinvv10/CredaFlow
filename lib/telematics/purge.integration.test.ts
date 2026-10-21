/**
 * Position retention on real Postgres (docs/asset-finance/SLICE5.md part B,
 * POPIA): each tenant's positions (one per device, its latest) older than its
 * own retention are deleted with the heartbeat, ignition and position events,
 * younger ones are kept,
 * METER and ALERT events and the access log survive, one audit row per
 * tenant. The database refuses a stale position, deleting an event something
 * still refers to or one inside retention, and a retention outside 1 to 365
 * days.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/purge.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { attempt, ruleAdmits, ruleRefuses, testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { ingestEvent } from "./ingest"
import { purgeTelematicsPositions } from "./purge"
import { revealPosition } from "./position-view"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const other = { tenantId: `t_tel_purge_${t}`, user: "", oldDevice: "", youngDevice: "" }
let fx: LeaseFixture
const ids = { loan: "", device: "" }
const DAY = 86_400_000

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const retention = (tenantId: string, days: number) => database().tenantConfig.update({ where: { tenantId }, data: { telematicsPositionRetentionDays: days } })
const before = (days: number) => new Date(Date.now() - days * DAY)
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
/** Test setup inside an attack's transaction: the statements run with triggers off. */
async function testSetupIn(tx: Tx, ...statements: [string, ...unknown[]][]): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
  for (const [statement, ...params] of statements) await tx.$executeRawUnsafe(statement, ...params)
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin")
}

/**
 * A second lender with two assets and a device on each, each holding one
 * position (written directly, triggers off: no lease runs here) from `days`
 * ago with its POSITION event.
 */
async function createOtherTenant(): Promise<void> {
  const tenantId = other.tenantId
  await database().tenant.create({ data: { id: tenantId, slug: `tel-purge-${t}`, name: "Telematics purge IT" } })
  await database().tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
  other.user = (await database().user.create({ data: { tenantId, email: `officer-${t}@purge.invalid`, password: "x", role: "CREDIT_OFFICER" } })).id
  const device = async (n: number, days: number) => {
    const asset = await database().financedAsset.create({ data: {
      tenantId, assetClass: "EXCAVATOR", make: "TEST", model: "EX-P", year: 2025, serialNumber: `PURGE${n}${t.toUpperCase()}`, cashPriceExclVatCents: 100_000_00, vatCents: 15_000_00,
    } })
    const id = (await database().trackerDevice.create({ data: {
      tenantId, assetId: asset.id, provider: "simulated", externalDeviceId: `SIM-STEADY-9${n}`, installedOn: new Date(`${daysAgo(100)}T00:00:00.000Z`), createdById: other.user,
    } })).id
    await testSetup(database(),
      [`INSERT INTO "TelematicsEvent" ("id", "tenantId", "deviceId", "provider", "providerEventId", "kind", "occurredAt", "simulated") VALUES ($1, $2, $3, 'simulated', $1, 'POSITION', $4, true)`,
        `ev${n}_${t}`, tenantId, id, before(days)],
      [`INSERT INTO "TelematicsPosition" ("id", "tenantId", "eventId", "deviceId", "occurredAt", "latitude", "longitude") VALUES ($1, $2, $3, $4, $5, -35.01, 20.01)`,
        `pos${n}_${t}`, tenantId, `ev${n}_${t}`, id, before(days)])
    return id
  }
  other.oldDevice = await device(1, 91)
  other.youngDevice = await device(2, 89)
}

suite.sequential("telematics position purge (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.loan = await bookOperatingLease(database(), fx, setSession, fx.assets[1], 60)
    ids.device = await installDevice(fx, fx.assets[1], "SIM-GEOFENCE-1", daysAgo(60))
    await createOtherTenant()
    await retention(fx.tenantId, 365)
    await retention(other.tenantId, 365)
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    // No agreement on the other lender's assets: nothing to poll.
    expect(await pollTenant(other.tenantId, new Date())).toMatchObject({ ok: true, devices: 0 })
    // One logged view, before the purge.
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.loan])
    const collector = (await database().user.create({ data: { tenantId: fx.tenantId, email: `collector-${t}@staff.invalid`, password: "x", role: "COLLECTIONS_OFFICER" } })).id
    expect(await revealPosition({ tenantId: fx.tenantId, userId: collector, userEmail: "c@x.invalid", role: "COLLECTIONS_OFFICER" }, ids.loan, { context: "DEFAULT" }, { ipAddress: null, userAgent: null }))
      .toMatchObject({ kind: "ok" })
    // The lease's one (latest) position, moved 31 days back with its event.
    const own = await database().telematicsPosition.findFirstOrThrow({ where: { deviceId: ids.device } })
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = $2 WHERE "id" = $1`, own.id, before(31)],
      [`UPDATE "TelematicsEvent" SET "occurredAt" = $2 WHERE "id" = $1`, own.eventId, before(31)])
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    if (db) {
      await testSetup(db,
        [`DELETE FROM "TelematicsPosition" WHERE "tenantId" = $1`, other.tenantId], [`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, other.tenantId],
        [`DELETE FROM "TelematicsEvent" WHERE "tenantId" = $1`, other.tenantId], [`DELETE FROM "TrackerDevice" WHERE "tenantId" = $1`, other.tenantId],
        [`DELETE FROM "FinancedAsset" WHERE "tenantId" = $1`, other.tenantId], [`DELETE FROM "User" WHERE "tenantId" = $1`, other.tenantId],
        [`DELETE FROM "TenantConfig" WHERE "tenantId" = $1`, other.tenantId], [`DELETE FROM "Tenant" WHERE "id" = $1`, other.tenantId])
      await db.$disconnect()
    }
  }, 60_000)

  it("deletes each tenant's positions past its own days, keeps the younger ones, the business events and the access log", async () => {
    const positions = (deviceId: string) => database().telematicsPosition.count({ where: { deviceId } })
    expect([await positions(ids.device), await positions(other.oldDevice), await positions(other.youngDevice)]).toEqual([1, 1, 1])
    const metersBefore = await database().telematicsEvent.count({ where: { deviceId: ids.device, kind: "METER" } })
    await retention(fx.tenantId, 30)
    await retention(other.tenantId, 90)

    const run = await purgeTelematicsPositions()
    expect(run).toMatchObject({ ok: true, failed: 0 })
    // 31 days past 30, 91 past 90: gone; 89 inside 90: kept.
    expect([await positions(ids.device), await positions(other.oldDevice), await positions(other.youngDevice)]).toEqual([0, 0, 1])
    expect(await database().telematicsEvent.count({ where: { id: `ev1_${t}` } })).toBe(0)
    expect(await database().telematicsEvent.count({ where: { deviceId: ids.device, kind: { in: ["HEARTBEAT", "POSITION"] }, occurredAt: { lt: before(30) } } })).toBe(0)
    expect(await database().telematicsEvent.count({ where: { deviceId: ids.device, kind: "METER" } })).toBe(metersBefore)
    // The geofence exit (day 20, 40 days ago) keeps its event and work item; its position is gone.
    const exit = await database().telematicsEvent.findFirstOrThrow({ where: { deviceId: ids.device, kind: "ALERT" }, include: { position: true, alert: true } })
    expect(exit.position).toBeNull()
    expect(exit.alert).not.toBeNull()
    expect(await database().telematicsPositionAccess.count({ where: { loanId: ids.loan } })).toBe(1)
    for (const tenantId of [fx.tenantId, other.tenantId]) {
      const audit = await database().auditLog.findMany({ where: { tenantId, action: "TELEMATICS_POSITIONS_PURGED" } })
      expect(audit).toHaveLength(1)
      expect(audit[0].userId).toBeNull()
      expect((audit[0].newValue as { positions: number }).positions).toBeGreaterThan(0)
    }
    // Idempotent: nothing more to delete, no new audit row.
    expect(await purgeTelematicsPositions()).toMatchObject({ ok: true, positions: 0, events: 0 })
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TELEMATICS_POSITIONS_PURGED" } })).toBe(1)
  }, 120_000)

  it("drops a position already past retention when it arrives, keeping its event", async () => {
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: ids.device } })
    const outcome = await database().$transaction((tx) => ingestEvent(tx as never, device, {
      providerEventId: `it:${randomUUID()}`, externalDeviceId: device.externalDeviceId, occurredAt: before(40), kind: "POSITION",
      position: { latitude: -35.01, longitude: 20.01, accuracyM: 5 },
    }, { now: new Date(), simulated: true, retentionDays: 30 }))
    expect(outcome).toMatchObject({ stored: true, positionStored: false })
  }, 120_000)

  it("refuses a stale position, deleting a business or a young event, truncating positions, and a retention outside 1 to 365 days", async () => {
    const stale = await database().telematicsEvent.findFirstOrThrow({ where: { deviceId: ids.device, kind: "ALERT" } })
    await ruleRefuses(database(), { fn: "guardTelematicsPosition", replace: [`IF NOT COALESCE(NEW."occurredAt" >= (now() AT TIME ZONE 'UTC') - make_interval(days => retention), FALSE) THEN`, "IF FALSE THEN"] },
      /older than the tenant's retention is not stored/,
      (tx) => tx.telematicsPosition.create({ data: { tenantId: fx.tenantId, eventId: stale.id, deviceId: ids.device, occurredAt: stale.occurredAt, latitude: -35.02, longitude: 20.02 } }))
    const young = await database().telematicsEvent.findFirstOrThrow({ where: { deviceId: ids.device, kind: "HEARTBEAT" }, orderBy: { occurredAt: "desc" } })
    const events = { table: "TelematicsEvent", trigger: "TelematicsEvent_guard" }
    // Past retention, an event nothing refers to may go, whatever its kind (a device reading only, here); one a reading refers to stays.
    await ruleAdmits(database(), async (tx) => {
      await testSetupIn(tx, [`INSERT INTO "TelematicsEvent" ("id", "tenantId", "deviceId", "provider", "providerEventId", "kind", "occurredAt", "meterValue", "meterUnit", "simulated")
        VALUES ($1, $2, $3, 'simulated', $1, 'METER', $4, 1000, 'HOURS', true)`, `meter_${t}`, fx.tenantId, ids.device, before(60)])
      await tx.telematicsEvent.delete({ where: { id: `meter_${t}` } })
    })
    const recorded = await database().telematicsEvent.findFirstOrThrow({ where: { deviceId: ids.device, kind: "METER", meterOutcome: "RECORDED" }, orderBy: { occurredAt: "asc" } })
    expect(recorded.occurredAt.getTime()).toBeLessThan(before(31).getTime())
    expect(await attempt(database(), (tx) => tx.telematicsEvent.delete({ where: { id: recorded.id } }))).toMatch(/a reading, held reading, alert or position refers to is not deleted/)
    await ruleRefuses(database(), events, /Only an event past the tenant's retention is deleted/, (tx) => tx.telematicsEvent.delete({ where: { id: young.id } }))
    await ruleRefuses(database(), { table: "TelematicsPosition", trigger: "TelematicsPosition_no_truncate" }, /never truncated/,
      (tx) => tx.$executeRawUnsafe(`TRUNCATE "TelematicsPosition"`))
    for (const days of [0, 366]) {
      await ruleRefuses(database(), { table: "TenantConfig", constraint: "TenantConfig_telematics_retention_range" }, /TenantConfig_telematics_retention_range/,
        (tx) => tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: days } }))
    }
  }, 120_000)
})
