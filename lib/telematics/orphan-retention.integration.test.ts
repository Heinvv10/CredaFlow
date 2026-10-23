/**
 * POPIA s14 repro (legal review round 2 of PR #222): a METER or ALERT event
 * that nothing refers to (an instalment sale's meter, NOT_LEASE; an alert
 * with no covering agreement) is never purged, and the database refuses its
 * deletion, so it is kept for ever with no purpose.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/orphan-retention.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { purgeTelematicsPositions } from "./purge"
import { bookInstalmentSale, cleanupTelematicsFixture, createTelematicsFixture, installDevice, loanStartDate, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let deviceId = ""

suite.sequential("orphan METER/ALERT events past retention (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(db!, t)
    const loanId = await bookInstalmentSale(db!, fx, (u) => { session.current = u && { user: u } }, fx.assets[1])
    deviceId = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", await loanStartDate(db!, loanId))
    await db!.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 1 } })
    // Setup (triggers off): two unreferenced events 20 days old, as the ingest leaves them.
    const old = new Date(Date.now() - 20 * 86_400_000)
    await db!.$transaction([
      db!.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db!.telematicsEvent.create({ data: { tenantId: fx.tenantId, deviceId, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind: "METER", occurredAt: old, meterValue: 1_200, meterUnit: "HOURS", simulated: true, meterOutcome: "NOT_LEASE" } }),
      db!.telematicsEvent.create({ data: { tenantId: fx.tenantId, deviceId, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind: "ALERT", occurredAt: old, alertKind: "GEOFENCE_EXIT", simulated: true } }),
    ])
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("purges an unreferenced METER or ALERT event past retention", async () => {
    await purgeTelematicsPositions()
    expect(await db!.telematicsEvent.count({ where: { deviceId, kind: { in: ["METER", "ALERT"] } } })).toBe(0)
  }, 120_000)
})
