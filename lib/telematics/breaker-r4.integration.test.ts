/**
 * Round-4 policy-breaker repros for PR #222 (docs/asset-finance/SLICE5.md part
 * B) on real Postgres. A real deadlock between two ORM statements is a passing
 * fault (fixed: never a strike, never skipped). A late event under a short
 * retention is dropped (accepted, a known limitation: pinned here). Every
 * value is synthetic.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/breaker-r4.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { pollTenant } from "./poll"
import { registerTelematicsProvider } from "./registry"
import { registerTrackerDevice } from "./devices"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, telematicsTestClient } from "./telematics.integration-fixture"
import type { NormalisedTelematicsEvent } from "./types"

const { session, inject } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } }, inject: { error: null as unknown } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
// The real ingest, unless a test injects a (real, captured) failure.
vi.mock("./ingest", async (original) => {
  const real = await original<typeof import("./ingest")>()
  return { ...real, ingestEvent: async (...args: Parameters<typeof real.ingestEvent>) => {
    if (inject.error) throw inject.error
    return real.ingestEvent(...args)
  } }
})

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { deviceA: "", deviceB: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}

/** A provider double that delivers the same queued events on every poll (no cursor), like a provider retrying a window. */
const queued: NormalisedTelematicsEvent[] = []
registerTelematicsProvider({
  id: "acme-r4", label: "Round-4 double", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
  poll: async () => ({ events: [...queued], cursors: {}, simulated: false }),
})

/** A real deadlock between two ORM statements, as Prisma reports it. */
async function realOrmDeadlock(a: string, b: string): Promise<unknown> {
  const pause = () => new Promise((r) => setTimeout(r, 400))
  const one = (first: string, second: string) => runWithTenant(fx.tenantId, () => prisma.$transaction(async (tx) => {
    await tx.trackerDevice.update({ where: { id: first, tenantId: fx.tenantId }, data: { lastPollError: "lock" } })
    await pause()
    await tx.trackerDevice.update({ where: { id: second, tenantId: fx.tenantId }, data: { lastPollError: "lock" } })
  }, { timeout: 20_000 }))
  const results = await Promise.allSettled([one(a, b), one(b, a)])
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined
  if (!failed) throw new Error("no deadlock happened")
  return failed.reason
}

suite.sequential("telematics policy breaker, round 4 (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    const actor = { tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` }
    const a = await registerTrackerDevice(actor, fx.assets[1], { provider: "acme-r4", externalDeviceId: "R4-A", installedOn: daysAgo(10) })
    const b = await registerTrackerDevice(actor, fx.assets[2], { provider: "acme-r4", externalDeviceId: "R4-B", installedOn: daysAgo(10) })
    ids.deviceA = (a as { id: string }).id
    ids.deviceB = (b as { id: string }).id
  }, 600_000)

  afterAll(async () => {
    inject.error = null
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("a real deadlock in an ORM statement is a passing fault: polls running never skip the TAMPER, and it is raised once the fault passes", async () => {
    const deadlock = await realOrmDeadlock(ids.deviceA, ids.deviceB)
    // Prisma does not map it: an unknown request error, the SQLSTATE only in the driver's PostgresError code field.
    expect((deadlock as Error).constructor.name).toBe("PrismaClientUnknownRequestError")
    expect(String((deadlock as Error).message)).toMatch(/PostgresError \{ code: "40P01"/)
    queued.splice(0, queued.length, { providerEventId: `r4-tamper-${t}`, externalDeviceId: "R4-A", occurredAt: new Date(Date.now() - 60_000), kind: "ALERT", alert: "TAMPER" })
    inject.error = deadlock
    const runs = []
    for (let i = 0; i < 5; i++) runs.push(await pollTenant(fx.tenantId, new Date()))
    inject.error = null
    expect(runs.map((r) => [r.failed, r.rejected])).toEqual([[1, 0], [1, 0], [1, 0], [1, 0], [1, 0]])
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TELEMATICS_EVENT_REJECTED", entityId: ids.deviceA } })).toBe(0)
    expect(await database().trackerDevice.findUniqueOrThrow({ where: { id: ids.deviceA } })).toMatchObject({ failingEventCount: 0 })
    // The fault passes: the provider sends the event again and the work item is raised.
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ stored: 1, failed: 0 })
    expect(await database().telematicsAlert.count({ where: { deviceId: ids.deviceA, kind: "TAMPER" } })).toBe(1)
    queued.splice(0)
  }, 120_000)

  // Accepted (lead decision, round 4): the retention floor refuses an event older than the tenant's retention, so a
  // device that buffers past a short retention loses that backlog. A known limitation in SLICE5 part B; this pins it.
  it("pinned limitation: under a short retention, a power-cut alert the device buffers and delivers late is refused and dropped", async () => {
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 1 } })
    // The device lost power for 30 hours (that is what POWER_CUT means), then reconnected and delivered its buffer.
    queued.splice(0, queued.length, { providerEventId: `r4-power-${t}`, externalDeviceId: "R4-B", occurredAt: new Date(Date.now() - 30 * 3_600_000), kind: "ALERT", alert: "POWER_CUT" })
    const run = await pollTenant(fx.tenantId, new Date())
    expect(run).toMatchObject({ rejected: 1, stored: 0 })
    expect(await database().telematicsAlert.count({ where: { deviceId: ids.deviceB } })).toBe(0)
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 90 } })
    queued.splice(0)
  }, 120_000)
})
