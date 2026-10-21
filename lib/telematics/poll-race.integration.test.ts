/**
 * Architecture review round 2 repro (PR #222), asserting the fix: a TAMPER
 * repeat racing a staff member's resolve of the open alert. The fold locks the
 * open alert first and re-reads it: resolved meanwhile, it no longer matches,
 * so the repeat raises a new OPEN item. And a meter event racing a staff
 * reading of the asset: the ingest locks the asset before its monotonic check,
 * so it sees the staff reading and holds the event against it. Nothing is
 * skipped or lost.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/poll-race.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { simulatedTelematics } from "./providers/simulated"
import { edgeHelpers } from "./edge.integration-fixture"
import { recordMeterReading } from "@/lib/asset-finance/meter-readings"
import { ingestEvent } from "./ingest"
import { alertEvent, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, eveningOf, meterEvent, telematicsTestClient, today } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const staffDb = RUN ? new PrismaClient({ errorFormat: "minimal" }) : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let lease: Awaited<ReturnType<typeof leaseWithDevice>>

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const { leaseWithDevice } = edgeHelpers(database, () => fx, (user) => { session.current = user && { user } })

suite.sequential("telematics poll: a staff race is not a poison event (real DB)", () => {
  beforeAll(async () => {
    fx = await createTelematicsFixture(database(), t)
    lease = await leaseWithDevice()
  }, 600_000)
  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
    await staffDb?.$disconnect()
  }, 60_000)
  afterEach(() => vi.restoreAllMocks())

  it("a tamper repeat racing a staff resolve opens a new item, not dropped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const first = alertEvent(lease.externalDeviceId, new Date(Date.now() - 2 * 3_600_000), "TAMPER")
    vi.spyOn(simulatedTelematics, "poll").mockResolvedValueOnce({ events: [first], cursors: { [lease.externalDeviceId]: "c1" }, simulated: true })
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ stored: 1, rejected: 0 })
    const alert = await database().telematicsAlert.findFirstOrThrow({ where: { deviceId: lease.deviceId, kind: "TAMPER" } })

    const repeat = alertEvent(lease.externalDeviceId, new Date(Date.now() - 3_600_000), "TAMPER")
    vi.spyOn(simulatedTelematics, "poll").mockResolvedValueOnce({ events: [repeat], cursors: { [lease.externalDeviceId]: "c2" }, simulated: true })
    // Staff resolve the alert in a transaction that commits while the poll's fold waits on the row.
    const resolving = staffDb!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "TelematicsAlert" SET "status" = 'RESOLVED', "resolvedById" = $2, "resolvedAt" = now(), "resolutionNote" = 'Checked on site', "updatedAt" = now() WHERE "id" = $1`,
        alert.id, fx.officer)
      await tx.$executeRawUnsafe("SELECT pg_sleep(3)")
    }, { timeout: 20_000 })
    await new Promise((r) => setTimeout(r, 800))
    const run = await pollTenant(fx.tenantId, new Date())
    await resolving

    const stored = await database().telematicsEvent.count({ where: { deviceId: lease.deviceId, providerEventId: repeat.providerEventId } })
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: lease.deviceId } })
    const open = await database().telematicsAlert.count({ where: { deviceId: lease.deviceId, kind: "TAMPER", status: { not: "RESOLVED" } } })
    expect({ run: { rejected: run.rejected, failed: run.failed }, stored, cursor: device.pollCursor, open }).toEqual(
      { run: { rejected: 0, failed: 0 }, stored: 1, cursor: "c2", open: 1 })
    expect((await database().telematicsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("RESOLVED")
  }, 300_000)

  it("a meter event racing a staff reading of the asset waits for it and is held against it, not refused", async () => {
    // Staff record 1 100 h five days ago and hold the asset's meter lock (the meter trigger takes it) for 3 s.
    const staffReading = staffDb!.$transaction(async (tx) => {
      const result = await recordMeterReading(tx as never, { tenantId: fx.tenantId, userId: fx.officer }, {
        loanId: lease.loanId, readingDate: daysAgo(5), value: 1_100, evidenceDocumentId: null, today: today(),
      })
      await tx.$executeRawUnsafe("SELECT pg_sleep(3)")
      return result
    }, { timeout: 20_000 })
    await new Promise((r) => setTimeout(r, 800))
    // The device says 1 150 h six days ago: above the staff reading dated after it.
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: lease.deviceId } })
    const outcome = await database().$transaction((tx) => ingestEvent(tx as never, device, meterEvent(lease.externalDeviceId, eveningOf(daysAgo(6)), 1_150),
      { now: new Date(), simulated: true, retentionDays: 90 }), { timeout: 20_000 })
    expect(await staffReading).toMatchObject({ kind: "recorded" })
    expect(outcome).toMatchObject({ stored: true, meterOutcome: "HELD" })
    expect(await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: lease.loanId } })).toMatchObject({ reason: "ABOVE_LATER", value: 1_150 })
  }, 300_000)
})
