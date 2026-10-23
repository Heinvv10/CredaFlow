/**
 * Edge cases of the telematics ingest on real Postgres (docs/asset-finance/SLICE5.md
 * part B): poison events, re-registered devices, re-leased assets, alert
 * folding under concurrency, device ids and held-reading decisions. A poison
 * event refused by the database itself (the shape check bypassed) is
 * poll-rejects.integration.test.ts.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/edge-cases-ingest.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "@/lib/asset-finance/dates"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { acceptHeldReading, rejectHeldReading } from "./held-readings"
import { resolveAlert } from "./alerts"
import { pollTenant } from "./poll"
import { simulatedTelematics } from "./providers/simulated"
import { registerTrackerDevice, removeTrackerDevice, trackerHeartbeat } from "./devices"
import { registerTelematicsProvider } from "./registry"
import type { NormalisedTelematicsEvent, TelematicsProvider } from "./types"
import { ceilingOn, edgeHelpers, evening, heartbeat } from "./edge.integration-fixture"
import {
  addAsset, alertEvent, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, meterEvent, telematicsTestClient, today,
} from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
// Every lease here is signed by the same lessee; the portal signing limit is per process and is not under test.
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRateLimit: () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let poisoned: Awaited<ReturnType<typeof leaseWithDevice>> | null = null

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` })
const DAY_MS = 86_400_000
const { leaseWithDevice, bareDevice, ingest, asTestSetup, nextSeq } = edgeHelpers(database, () => fx, setSession)

suite.sequential("telematics edge cases: poison events, devices, alerts, held readings (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
  }, 600_000)
  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ["an event dated before the installation day", "before the installation", (ext: string) => heartbeat(ext, new Date(Date.now() - 40 * DAY_MS))],
    ["an event 6 minutes in the future", "more than five minutes ahead", (ext: string) => heartbeat(ext, new Date(Date.now() + 6 * 60_000))],
    ["a provider event id with a NUL character", "provider event id", (ext: string) => ({ ...heartbeat(ext, new Date(Date.now() - 60_000)), providerEventId: "bad\u0000id" })],
    ["a meter value above the 32-bit column", "meter value", (ext: string) => evening(ext, daysAgo(1), 3_000_000_000)],
  ])("a poison event (%s) is skipped, counted and audited; the good event behind it is stored and the cursor moves past", async (_name, reason, make) => {
    poisoned ??= await leaseWithDevice()
    const d = poisoned
    const good = heartbeat(d.externalDeviceId, new Date(Date.now() - 3_600_000))
    const poison = make(d.externalDeviceId) as NormalisedTelematicsEvent
    const cursor = good.occurredAt.toISOString()
    vi.spyOn(simulatedTelematics, "poll").mockResolvedValue({ events: [poison, good], cursors: { [d.externalDeviceId]: cursor }, simulated: true })
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, rejected: 1, failed: 0 })
    expect(await database().telematicsEvent.count({ where: { deviceId: d.deviceId, providerEventId: good.providerEventId } })).toBe(1)
    expect((await database().trackerDevice.findUniqueOrThrow({ where: { id: d.deviceId } })).pollCursor).toBe(cursor)
    const audit = await database().auditLog.findFirstOrThrow({ where: { tenantId: fx.tenantId, action: "TELEMATICS_EVENT_REJECTED", entityId: d.deviceId }, orderBy: { createdAt: "desc" } })
    expect(audit.newValue).toMatchObject({ reason, providerEventId: poison.providerEventId.replace("\u0000", "?") })
  }, 300_000)

  it("a device removed and re-registered on the same asset (same device id, later install) receives its own new events", async () => {
    const assetId = await addAsset(database(), fx)
    await bookOperatingLease(database(), fx, setSession, assetId, 10)
    const ext = `SIM-STEADY-${nextSeq()}`
    const first = await installDevice(fx, assetId, ext, daysAgo(6))
    await pollTenant(fx.tenantId, new Date())
    expect(await database().telematicsEvent.count({ where: { deviceId: first } })).toBeGreaterThan(10)
    expect(await removeTrackerDevice(officer(), first, {})).toMatchObject({ kind: "ok" })
    const second = await installDevice(fx, assetId, ext, daysAgo(2))
    await pollTenant(fx.tenantId, new Date())
    expect(await database().telematicsEvent.count({ where: { deviceId: second } })).toBeGreaterThan(0)
    expect((await trackerHeartbeat(fx.tenantId, assetId))?.lastSeenAt).not.toBeNull()
  }, 300_000)

  it("an asset re-leased the day the old loan closed: the reading goes to the new lease", async () => {
    const assetId = await addAsset(database(), fx)
    const first = await bookOperatingLease(database(), fx, setSession, assetId, 30)
    await asTestSetup([`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, first], [`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = $2, "cancelReason" = 'test setup: the old lease is over' WHERE "loanId" = $1`, first, fx.officer])
    const second = await bookOperatingLease(database(), fx, setSession, assetId, 0)
    const ext = `SIM-STEADY-${nextSeq()}`
    const deviceId = await installDevice(fx, assetId, ext, daysAgo(30))
    const outcome = await ingest(deviceId, meterEvent(ext, new Date(Date.now() - 60_000), 1_100))
    expect(outcome).toMatchObject({ stored: true })
    const row = await database().assetMeterReading.findFirst({ where: { source: "TELEMATICS", telematicsEventId: (outcome as { eventId: string }).eventId } })
    expect(row?.loanId, JSON.stringify(outcome)).toBe(second)
  }, 600_000)

  it("an alert repeating after RESOLVED opens a new item; a repeat before folds into the open one", async () => {
    const d = await leaseWithDevice()
    const first = await ingest(d.deviceId, alertEvent(d.externalDeviceId, new Date(Date.now() - 3 * 3_600_000), "TAMPER"))
    const repeat = await ingest(d.deviceId, alertEvent(d.externalDeviceId, new Date(Date.now() - 2 * 3_600_000), "TAMPER"))
    expect((first as { alertId: string }).alertId).toBe((repeat as { alertId: string }).alertId)
    expect(await resolveAlert(officer(), (first as { alertId: string }).alertId, { note: "Checked, false alarm" })).toMatchObject({ kind: "ok" })
    const after = await ingest(d.deviceId, alertEvent(d.externalDeviceId, new Date(Date.now() - 3_600_000), "TAMPER"))
    expect((after as { alertId: string }).alertId).not.toBe((first as { alertId: string }).alertId)
    const alerts = await database().telematicsAlert.findMany({ where: { deviceId: d.deviceId }, orderBy: { createdAt: "asc" } })
    expect(alerts.map((a) => [a.status, a.occurrences])).toEqual([["RESOLVED", 2], ["OPEN", 1]])
  }, 300_000)

  it("two alert events of one kind ingested at once fold into one item and neither fails", async () => {
    const d = await leaseWithDevice()
    const rejected: unknown[] = []
    for (let i = 0; i < 6; i++) {
      const results = await Promise.allSettled([
        ingest(d.deviceId, alertEvent(d.externalDeviceId, new Date(Date.now() - 7_200_000 + i * 1000), "POWER_CUT")),
        ingest(d.deviceId, alertEvent(d.externalDeviceId, new Date(Date.now() - 3_600_000 + i * 1000), "POWER_CUT")),
      ])
      rejected.push(...results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.message))
      const open = await database().telematicsAlert.findFirst({ where: { deviceId: d.deviceId, status: { not: "RESOLVED" } } })
      expect(open?.occurrences).toBe(2)
      if (open) await resolveAlert(officer(), open.id, { note: "iteration resolved" })
    }
    expect(rejected).toEqual([])
  }, 300_000)

  it("the same providerEventId from two providers is two events", async () => {
    const a = await bareDevice(daysAgo(2))
    const assetB = await addAsset(database(), fx)
    const other = await database().trackerDevice.create({
      data: { tenantId: fx.tenantId, assetId: assetB, provider: "other-provider", externalDeviceId: `OTH-${nextSeq()}`, installedOn: dbDate(daysAgo(2)), createdById: fx.officer },
    })
    const shared = `it:${randomUUID()}`
    const at = new Date(Date.now() - 60_000)
    expect(await ingest(a.deviceId, { ...heartbeat(a.externalDeviceId, at), providerEventId: shared })).toMatchObject({ stored: true })
    expect(await ingest(other.id, { ...heartbeat(other.externalDeviceId, at), providerEventId: shared })).toMatchObject({ stored: true })
  }, 300_000)

  it("device ids: oversize and control characters are refused with a 422, never a 500", async () => {
    const double: TelematicsProvider = { ...simulatedTelematics, id: "edge-double", deviceIdError: () => null, assertUsable: () => undefined }
    registerTelematicsProvider(double)
    const asset = await addAsset(database(), fx)
    const reg = (externalDeviceId: string) => registerTrackerDevice(officer(), asset, { provider: "edge-double", externalDeviceId, installedOn: today() })
    expect(await reg("x".repeat(101))).toMatchObject({ kind: "refused", status: 422 })
    expect(await reg("bad\u0000id")).toMatchObject({ kind: "refused", status: 422, fields: { externalDeviceId: "The device id cannot hold control characters" } })
    expect(await reg("é".repeat(100))).toMatchObject({ kind: "ok" })
  }, 300_000)

  it("held reading accept after the loan is COMPLETED, and after the term end, is a 422 and leaves the hold HELD", async () => {
    const l = await leaseWithDevice()
    const day = daysAgo(6)
    expect(await ingest(l.deviceId, evening(l.externalDeviceId, day, ceilingOn(l.start, day) + 5_000))).toMatchObject({ meterOutcome: "HELD" })
    await asTestSetup([`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, l.loanId])
    const held = await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: l.loanId } })
    expect(await acceptHeldReading(officer(), held.id, { note: "Checked on site" })).toMatchObject({ kind: "refused", status: 422 })
    expect((await database().telematicsHeldReading.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("HELD")

    const m = await leaseWithDevice()
    expect(await ingest(m.deviceId, evening(m.externalDeviceId, day, ceilingOn(m.start, day) + 5_000))).toMatchObject({ meterOutcome: "HELD" })
    const heldM = await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: m.loanId } })
    await asTestSetup([`UPDATE "LeaseRental" SET "dueDate" = LEAST("dueDate", $2::date) WHERE "loanId" = $1`, m.loanId, daysAgo(7)])
    expect(await acceptHeldReading(officer(), heldM.id, { note: "Checked on site" })).toMatchObject({ kind: "refused", status: 422 })
    expect((await database().telematicsHeldReading.findUniqueOrThrow({ where: { id: heldM.id } })).status).toBe("HELD")
  }, 600_000)

  it("concurrent accept and reject of one held reading: exactly one wins and the row agrees with it", async () => {
    const l = await leaseWithDevice()
    for (let k = 0; k < 6; k++) {
      const day = daysAgo(20 - k)
      expect(await ingest(l.deviceId, evening(l.externalDeviceId, day, ceilingOn(l.start, day) + 200))).toMatchObject({ meterOutcome: "HELD" })
      const held = await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: l.loanId, readingDate: dbDate(day) } })
      const [acc, rej] = await Promise.all([acceptHeldReading(officer(), held.id, { note: "Accepted at once" }), rejectHeldReading(officer(), held.id, { note: "Rejected at once" })])
      const winners = [acc, rej].filter((r) => r.kind === "ok")
      expect(winners.length, JSON.stringify([acc, rej])).toBe(1)
      const row = await database().telematicsHeldReading.findUniqueOrThrow({ where: { id: held.id } })
      expect(row.status).toBe(acc.kind === "ok" ? "ACCEPTED" : "REJECTED")
      expect(await database().assetMeterReading.count({ where: { telematicsEventId: held.eventId } })).toBe(acc.kind === "ok" ? 1 : 0)
    }
  }, 600_000)
})
