/**
 * The poll's second line on real Postgres (docs/asset-finance/SLICE5.md part
 * B): with the shape check bypassed, a poison event reaches the database,
 * which refuses it (a rule, a byte or a number its column cannot hold). The
 * poll skips it, counts and audits it, and moves the cursor past it: one bad
 * event never wedges a device.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/poll-rejects.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { simulatedTelematics } from "./providers/simulated"
import type { NormalisedTelematicsEvent } from "./types"
import { edgeHelpers, evening, heartbeat } from "./edge.integration-fixture"
import { cleanupTelematicsFixture, createTelematicsFixture, daysAgo, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
// The shape check passes everything here: only the database stands in the way.
vi.mock("./event-shape", async (original) => ({ ...(await original<typeof import("./event-shape")>()), invalidEvent: () => null }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let lease: Awaited<ReturnType<typeof leaseWithDevice>>

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const { leaseWithDevice } = edgeHelpers(database, () => fx, (user) => { session.current = user && { user } })

suite.sequential("telematics poll: an event the database refuses is skipped, never retried (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    lease = await leaseWithDevice()
  }, 600_000)
  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ["dated before the installation day", /\(23514\)/, (ext: string) => heartbeat(ext, new Date(`${daysAgo(40)}T10:00:00.000Z`))],
    ["a provider event id with a NUL character", /\(22021\)/, (ext: string) => ({ ...heartbeat(ext, new Date(Date.now() - 60_000)), providerEventId: `bad\u0000${randomUUID()}` })],
    ["a meter value above the 32-bit column", /\(out of range\)/, (ext: string) => evening(ext, daysAgo(1), 3_000_000_000)],
  ])("%s: refused by the database, skipped, audited; the good event behind it is stored", async (_name, code, make) => {
    const good = heartbeat(lease.externalDeviceId, new Date(Date.now() - 3_600_000))
    const poison = make(lease.externalDeviceId) as NormalisedTelematicsEvent
    const cursor = good.occurredAt.toISOString()
    vi.spyOn(simulatedTelematics, "poll").mockResolvedValue({ events: [poison, good], cursors: { [lease.externalDeviceId]: cursor }, simulated: true })
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, rejected: 1, failed: 0, stored: 1 })
    expect(await database().telematicsEvent.count({ where: { deviceId: lease.deviceId, providerEventId: good.providerEventId } })).toBe(1)
    expect(await database().trackerDevice.findUniqueOrThrow({ where: { id: lease.deviceId } })).toMatchObject({ pollCursor: cursor, lastPollError: null })
    const audit = await database().auditLog.findFirstOrThrow({ where: { tenantId: fx.tenantId, action: "TELEMATICS_EVENT_REJECTED", entityId: lease.deviceId }, orderBy: { createdAt: "desc" } })
    expect((audit.newValue as { reason: string }).reason).toMatch(code)
  }, 300_000)
})
