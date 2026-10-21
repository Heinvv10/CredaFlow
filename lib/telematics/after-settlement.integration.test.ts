/**
 * POPIA s10/s11 (legal review of PR #222), asserting the fix: a tracker left
 * ACTIVE on an asset whose finance agreement has closed keeps nothing but a
 * heartbeat, and no position, though it reports one.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/after-settlement.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { ingestEvent } from "./ingest"
import { bookInstalmentSale, cleanupTelematicsFixture, createTelematicsFixture, installDevice, loanStartDate, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let loanId = ""
let deviceId = ""

suite.sequential("telematics after the agreement closes (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(db!, t)
    loanId = await bookInstalmentSale(db!, fx, (u) => { session.current = u && { user: u } }, fx.assets[1])
    deviceId = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", await loanStartDate(db!, loanId))
    // Setup: the borrower paid up and the agreement closed.
    await db!.$transaction([
      db!.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db!.$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, loanId),
    ])
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("stores no position for an asset with no running agreement", async () => {
    const device = await db!.trackerDevice.findUniqueOrThrow({ where: { id: deviceId } })
    const now = new Date()
    const outcome = await db!.$transaction((tx) => ingestEvent(tx as never, device, {
      providerEventId: `it:${randomUUID()}`, externalDeviceId: device.externalDeviceId, occurredAt: new Date(now.getTime() - 60_000), kind: "POSITION",
      position: { latitude: -26.1, longitude: 28.0, accuracyM: 10 },
    }, { now, simulated: true, retentionDays: 90 }))
    // Not even the event is kept: with no agreement only a heartbeat is.
    expect(outcome).toEqual({ stored: false, noAgreement: true })
    expect(await db!.telematicsPosition.count({ where: { deviceId } })).toBe(0)
    expect(await db!.telematicsEvent.count({ where: { deviceId } })).toBe(0)
  }, 120_000)
})
