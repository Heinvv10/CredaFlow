/**
 * A tracker before payout, on real Postgres (docs/asset-finance/SLICE5.md part
 * B, Deviation 19): a device on an asset whose deal is approved or contracted
 * is polled, so the payout checklist shows its heartbeat, but with no booked
 * loan only the heartbeat is kept: no position, ignition, meter or alert
 * event (the database refuses any but a heartbeat). A cancelled or declined deal, or an asset with no
 * deal, is not polled at all.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/pre-payout.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { approveLease, leaseBody, signLease, type LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { trackerHeartbeat } from "./devices"
import { cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { contracted: "", approved: "", tamper: "", steady: "", bare: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const staff = (id: string, role: string) => { session.current = { user: { id, email: `${id}@telematics-it.test`, role, tenantId: fx.tenantId } } }
const counts = async (deviceId: string) => ({
  events: await database().telematicsEvent.count({ where: { deviceId } }),
  positions: await database().telematicsPosition.count({ where: { deviceId } }),
  alerts: await database().telematicsAlert.count({ where: { deviceId } }),
  readings: await database().assetMeterReading.count({ where: { telematicsEvent: { deviceId } } }),
})

suite.sequential("telematics before payout: a heartbeat, nothing else (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    const lease = (assetId: string) => approveLease(fx, staff, leaseBody(fx, { assetId, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    ids.contracted = await lease(fx.assets[1])
    await signLease(fx, database(), (user) => { session.current = user && { user } }, ids.contracted)
    ids.approved = await lease(fx.assets[2])
    expect((await database().assetFinanceDeal.findMany({ where: { id: { in: [ids.contracted, ids.approved] } }, orderBy: { id: "asc" } })).map((d) => [d.id, d.status]).sort())
      .toEqual([[ids.contracted, "CONTRACTED"], [ids.approved, "APPROVED"]].sort())
    ids.tamper = await installDevice(fx, fx.assets[1], "SIM-TAMPER-1", daysAgo(30))
    ids.steady = await installDevice(fx, fx.assets[2], "SIM-STEADY-2", daysAgo(5))
    ids.bare = await installDevice(fx, fx.assets[3], "SIM-STEADY-3", daysAgo(5))
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("polls an approved or contracted deal's device: a heartbeat, but no position, no alert and no meter reading", async () => {
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, devices: 2, failed: 0, rejected: 0, notKept: expect.any(Number) })
    const tamper = await counts(ids.tamper)
    expect(tamper).toMatchObject({ positions: 0, alerts: 0, readings: 0 })
    // Only the heartbeats are kept (31 days of them): no position, ignition, meter or alert event before booking.
    expect(tamper.events).toBe(31)
    expect(await database().telematicsEvent.count({ where: { deviceId: ids.tamper, kind: { not: "HEARTBEAT" } } })).toBe(0)
    expect((await trackerHeartbeat(fx.tenantId, fx.assets[1]))?.lastSeenAt).not.toBeNull()
    expect((await counts(ids.steady)).events).toBeGreaterThan(0)
    expect(await counts(ids.bare)).toEqual({ events: 0, positions: 0, alerts: 0, readings: 0 })
  }, 300_000)

  it("stops polling once the deal is cancelled or declined", async () => {
    await testSetup(database(),
      [`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = $2, "cancelReason" = 'test setup: the deal fell through' WHERE "id" = $1`, ids.contracted, fx.officer],
      [`UPDATE "AssetFinanceDeal" SET "status" = 'DECLINED' WHERE "id" = $1`, ids.approved],
      [`UPDATE "TrackerDevice" SET "pollCursor" = NULL WHERE "tenantId" = $1`, fx.tenantId])
    const before = await Promise.all([counts(ids.tamper), counts(ids.steady)])
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, devices: 0, stored: 0 })
    expect(await Promise.all([counts(ids.tamper), counts(ids.steady)])).toEqual(before)
  }, 300_000)
})
