/**
 * Review repro for PR #222 (test review): clauses the Part B suites left
 * unmutated, a position's device and time binding, and a repeat folding into
 * an ACKNOWLEDGED alert.
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=... npx vitest run lib/telematics/review-gaps.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleRefuses } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { acknowledgeAlert } from "./alerts"
import { ingestEvent } from "./ingest"
import { alertEvent, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loanA: "", deviceA: "", deviceB: "", alert: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const database = (): PrismaClient => { if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required"); return db }
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` })
/** A position event on device A, and a position for it on `deviceId` (whose current one is deleted first: one per device). */
const position = (tx: Tx, deviceId: string, shiftMs: number) => tx.telematicsPosition.deleteMany({ where: { deviceId } }).then(() => tx.telematicsEvent.create({ data: {
  tenantId: fx.tenantId, deviceId: ids.deviceA, provider: "simulated", providerEventId: `it:${randomUUID()}`, kind: "POSITION", occurredAt: new Date(), simulated: true,
} }).then((e) => tx.telematicsPosition.create({ data: {
  tenantId: fx.tenantId, eventId: e.id, deviceId, occurredAt: new Date(e.occurredAt.getTime() + shiftMs), latitude: -34.5, longitude: 20.5,
} })))

suite.sequential("review gaps (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.loanA = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    ids.deviceA = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", daysAgo(30))
    ids.deviceB = await installDevice(fx, fx.assets[2], "SIM-STEADY-2", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("binds a position to its event's device (not another asset's) and to its event's time", async () => {
    const P = { table: "TelematicsPosition", trigger: "TelematicsPosition_guard" }
    await ruleRefuses(database(), P, /its position or alert event's, on that event's device at its time/, (tx) => position(tx, ids.deviceB, 0))
    await ruleRefuses(database(), P, /its position or alert event's, on that event's device at its time/, (tx) => position(tx, ids.deviceA, -60_000))
  }, 120_000)

  it("folds a repeat into an ACKNOWLEDGED alert (no second unresolved item, no throw)", async () => {
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: ids.deviceA } })
    const ingest = () => database().$transaction((tx) => ingestEvent(tx as never, device, alertEvent(device.externalDeviceId, new Date(), "TAMPER"), { now: new Date(), simulated: true, retentionDays: 90 }))
    ids.alert = ((await ingest()) as { alertId: string }).alertId
    expect(await acknowledgeAlert(officer(), ids.alert)).toMatchObject({ kind: "ok" })
    await ingest()
    expect(await database().telematicsAlert.findUniqueOrThrow({ where: { id: ids.alert } })).toMatchObject({ status: "ACKNOWLEDGED", occurrences: 2 })
  }, 120_000)
})
