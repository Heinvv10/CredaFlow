/**
 * Tracker alerts on real Postgres (docs/asset-finance/SLICE5.md part B): a
 * tamper or power cut raises a work item on the loan whose tenure covers it:
 * servicing for a loan in good standing, collections in default, recovery
 * when the loan has an open legal matter or recovery. A repeat folds into the
 * open item (an acknowledged one too), and nothing is sent to anyone. The work item's lifecycle is the
 * database's: a resolve needs a note, a resolved item is final, the queue is
 * fixed, nothing is deleted.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/alerts.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient, TelematicsAlertKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleAdmits, ruleRefuses, testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { ingestEvent } from "./ingest"
import { acknowledgeAlert, resolveAlert } from "./alerts"
import { alertEvent, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { collectionsLoan: "", legalLoan: "", collectionsDevice: "", legalDevice: "", queueLoan: "", queueDevice: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` })
const alertsOf = (deviceId: string) => database().telematicsAlert.findMany({ where: { deviceId }, orderBy: { firstOccurredAt: "asc" } })
const R = { table: "TelematicsAlert", trigger: "TelematicsAlert_guard" }
const raise = async (deviceId: string, kind: TelematicsAlertKind, at = new Date()) => {
  const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: deviceId } })
  return database().$transaction((tx) => ingestEvent(tx as never, device, alertEvent(device.externalDeviceId, at, kind), { now: new Date(), simulated: true, retentionDays: 90 }))
}

suite.sequential("telematics alerts: work items, no messages, a guarded lifecycle (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.collectionsLoan = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    ids.legalLoan = await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    // Test setup: the second lease is in legal action (an OPEN matter).
    await testSetup(database(), [`INSERT INTO "LegalMatter" ("id", "tenantId", "loanId", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, now())`,
      `lm_${t}`, fx.tenantId, ids.legalLoan, fx.adminA])
    ids.collectionsDevice = await installDevice(fx, fx.assets[1], "SIM-TAMPER-1", daysAgo(30))
    ids.legalDevice = await installDevice(fx, fx.assets[2], "SIM-TAMPER-2", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    ids.queueLoan = await bookOperatingLease(database(), fx, setSession, fx.assets[3])
    ids.queueDevice = await installDevice(fx, fx.assets[3], "SIM-STEADY-3", daysAgo(30))
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("raises a tamper and a power cut as OPEN work items on the deal: servicing in good standing, recovery once legal action is open", async () => {
    expect((await alertsOf(ids.collectionsDevice)).map((a) => [a.kind, a.queue, a.status, a.occurrences, a.loanId])).toEqual([
      ["TAMPER", "SERVICING", "OPEN", 1, ids.collectionsLoan], ["POWER_CUT", "SERVICING", "OPEN", 1, ids.collectionsLoan],
    ])
    expect((await alertsOf(ids.legalDevice)).map((a) => [a.kind, a.queue])).toEqual([["TAMPER", "RECOVERY"], ["POWER_CUT", "RECOVERY"]])
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TELEMATICS_ALERT_RAISED" } })).toBe(4)
  }, 120_000)

  it("queues a loan in default for collections, and one with only an open recovery for recovery", async () => {
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.queueLoan])
    const defaulted = await raise(ids.queueDevice, "TAMPER")
    expect(await database().telematicsAlert.findUniqueOrThrow({ where: { id: (defaulted as { alertId: string }).alertId } })).toMatchObject({ queue: "COLLECTIONS", loanId: ids.queueLoan })
    // Recovered today: an exit from yesterday (inside the tenure) is a recovery item; one from today has no tenure, so no item.
    await testSetup(database(), [`INSERT INTO "Recovery" ("id", "tenantId", "loanId", "assetId", "route", "status", "recoveredOn", "location", "condition", "createdById", "updatedAt")
      VALUES ($1, $2, $3, $4, 'NON_NCA_COURT_ORDER', 'RECOVERED', CURRENT_DATE, 'Synthetic yard', 'Synthetic condition', $5, now())`, `rcq_${t}`, fx.tenantId, ids.queueLoan, fx.assets[3], fx.adminA])
    const before = await raise(ids.queueDevice, "GEOFENCE_EXIT", new Date(Date.now() - 86_400_000))
    expect(await database().telematicsAlert.findUniqueOrThrow({ where: { id: (before as { alertId: string }).alertId } })).toMatchObject({ queue: "RECOVERY" })
    expect(await raise(ids.queueDevice, "POWER_CUT")).toEqual({ stored: false, noAgreement: true })
    expect(await database().telematicsAlert.count({ where: { deviceId: ids.queueDevice, kind: "POWER_CUT" } })).toBe(0)
  }, 300_000)

  it("folds a repeat into the open item, and sends nothing to anyone", async () => {
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: ids.collectionsDevice } })
    const outcome = await database().$transaction((tx) => ingestEvent(tx as never, device, alertEvent(device.externalDeviceId, new Date(), "TAMPER"), { now: new Date(), simulated: true, retentionDays: 90 }))
    expect(outcome).toMatchObject({ stored: true })
    const [tamper] = await alertsOf(ids.collectionsDevice)
    expect(tamper).toMatchObject({ kind: "TAMPER", occurrences: 2, status: "OPEN" })
    expect(tamper.lastOccurredAt.getTime()).toBeGreaterThan(tamper.firstOccurredAt.getTime())
    expect(await database().telematicsAlert.count({ where: { deviceId: { in: [ids.collectionsDevice, ids.legalDevice] } } })).toBe(4)
    for (const count of [
      database().message.count({ where: { conversation: { tenantId: fx.tenantId } } }),
      database().notification.count({ where: { tenantId: fx.tenantId } }),
      database().notificationLog.count({ where: { tenantId: fx.tenantId } }),
      database().emailLog.count({ where: { tenantId: fx.tenantId } }),
    ]) expect(await count).toBe(0)
  }, 120_000)

  it("is acknowledged, then resolved with a note, by collections staff, audited; resolved is final", async () => {
    const [tamper] = await alertsOf(ids.collectionsDevice)
    expect(await acknowledgeAlert(officer(), tamper.id)).toMatchObject({ kind: "ok" })
    expect(await acknowledgeAlert(officer(), tamper.id)).toMatchObject({ kind: "refused", status: 409 })
    expect(await resolveAlert(officer(), tamper.id, { note: " " })).toMatchObject({ kind: "refused", status: 400 })
    expect(await resolveAlert(officer(), tamper.id, { note: "Tracker reseated by the installer" })).toMatchObject({ kind: "ok" })
    expect(await database().telematicsAlert.findUniqueOrThrow({ where: { id: tamper.id } })).toMatchObject({ status: "RESOLVED", resolvedById: fx.officer, acknowledgedById: fx.officer })
    for (const action of ["TELEMATICS_ALERT_ACKNOWLEDGED", "TELEMATICS_ALERT_RESOLVED"]) {
      expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action, entityId: tamper.id } })).toBe(1)
    }
    expect(await resolveAlert(officer(), tamper.id, { note: "again" })).toMatchObject({ kind: "refused", status: 409 })
    // A new tamper after the resolve opens a new item.
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: ids.collectionsDevice } })
    await database().$transaction((tx) => ingestEvent(tx as never, device, alertEvent(device.externalDeviceId, new Date(), "TAMPER"), { now: new Date(), simulated: true, retentionDays: 90 }))
    expect((await alertsOf(ids.collectionsDevice)).filter((a) => a.kind === "TAMPER").map((a) => a.status)).toEqual(["RESOLVED", "OPEN"])
  }, 120_000)

  it("the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind", async () => {
    const [powerCut] = (await alertsOf(ids.collectionsDevice)).filter((a) => a.kind === "POWER_CUT")
    const resolved = (await alertsOf(ids.collectionsDevice)).find((a) => a.status === "RESOLVED")!
    const update = (id: string, data: Record<string, unknown>) => (tx: Tx) => tx.telematicsAlert.update({ where: { id }, data })
    await ruleRefuses(database(), { table: "TelematicsAlert", constraint: "TelematicsAlert_status_shape" }, /TelematicsAlert_status_shape/,
      update(powerCut.id, { status: "RESOLVED", resolvedById: fx.officer, resolvedAt: new Date() }))
    const reopened = (await alertsOf(ids.collectionsDevice)).find((a) => a.kind === "TAMPER" && a.status === "OPEN")!
    await ruleRefuses(database(), R, /A resolved telematics alert is final/, async (tx) => {
      await update(reopened.id, { status: "RESOLVED", resolvedById: fx.officer, resolvedAt: new Date(), resolutionNote: "Out of the way" })(tx)
      await update(resolved.id, { status: "ACKNOWLEDGED", resolvedById: null, resolvedAt: null, resolutionNote: null, acknowledgedById: fx.officer, acknowledgedAt: new Date() })(tx)
    })
    await ruleRefuses(database(), R, /queue and first occurrence are fixed/, update(powerCut.id, { queue: "RECOVERY" }))
    // A repeat may move the item to the queue its loan calls for now.
    await ruleAdmits(database(), update(powerCut.id, { queue: "RECOVERY", occurrences: powerCut.occurrences + 1 }))
    await ruleRefuses(database(), R, /never deleted/, (tx) => tx.telematicsAlert.delete({ where: { id: powerCut.id } }))
    await ruleRefuses(database(), R, /adds one occurrence/, update(powerCut.id, { occurrences: 5 }))
    await ruleRefuses(database(), R, /cannot move from OPEN to OPEN|cannot move from ACKNOWLEDGED to OPEN/, async (tx) => {
      await update(powerCut.id, { status: "ACKNOWLEDGED", acknowledgedById: fx.officer, acknowledgedAt: new Date() })(tx)
      await update(powerCut.id, { status: "OPEN", acknowledgedById: null, acknowledgedAt: null })(tx)
    })
    await ruleRefuses(database(), { index: "TelematicsAlert_one_unresolved" }, /Unique constraint failed/, async (tx) => {
      const device = await tx.trackerDevice.findUniqueOrThrow({ where: { id: ids.collectionsDevice } })
      const event = await tx.telematicsEvent.create({ data: {
        tenantId: fx.tenantId, deviceId: device.id, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind: "ALERT", alertKind: "POWER_CUT", occurredAt: new Date(), simulated: true,
      } })
      await tx.telematicsAlert.create({ data: {
        tenantId: fx.tenantId, eventId: event.id, deviceId: device.id, assetId: device.assetId, loanId: ids.collectionsLoan, kind: "POWER_CUT", queue: "COLLECTIONS",
        firstOccurredAt: event.occurredAt, lastOccurredAt: event.occurredAt,
      } })
    })
    await ruleRefuses(database(), R, /raised by an alert event of its kind/, async (tx) => {
      const heartbeat = await tx.telematicsEvent.findFirstOrThrow({ where: { deviceId: ids.legalDevice, kind: "HEARTBEAT" } })
      await tx.telematicsAlert.create({ data: {
        tenantId: fx.tenantId, eventId: heartbeat.id, deviceId: ids.legalDevice, assetId: fx.assets[2], loanId: ids.legalLoan, kind: "GEOFENCE_EXIT", queue: "COLLECTIONS",
        firstOccurredAt: heartbeat.occurredAt, lastOccurredAt: heartbeat.occurredAt,
      } })
    })
  }, 120_000)
})
