/**
 * Round-2 edge cases of the telematics ingest on real Postgres (docs/asset-finance/SLICE5.md part B),
 * asserting the fixed behaviour:
 * what happens to an alert across a change of the loan's standing or of the loan itself, a real provider's
 * unverified meter, and a loan that leaves ACTIVE/DEFAULTED while recovery is still going on.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/edge-round2.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { acceptHeldReading, rejectHeldReading } from "./held-readings"
import { verifyTrackerMeter } from "./devices"
import { pollTenant } from "./poll"
import { registerTelematicsProvider } from "./registry"
import { simulatedTelematics } from "./providers/simulated"
import type { TelematicsProvider } from "./types"
import { ceilingOn, edgeHelpers, evening, positionEvent } from "./edge.integration-fixture"
import {
  addAsset, alertEvent, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, meterEvent, telematicsTestClient,
} from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRateLimit: () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` })
const { leaseWithDevice, ingest, asTestSetup, nextSeq } = edgeHelpers(database, () => fx, setSession)
const restore = (loanId: string) => asTestSetup([`UPDATE "Loan" SET "status" = 'ACTIVE' WHERE "id" = $1`, loanId])
const ago = (ms: number) => new Date(Date.now() - ms)
const HOUR = 3_600_000

suite.sequential("telematics round-2 edge cases (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
  }, 600_000)
  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("an alert raised while the loan is in good standing (SERVICING) moves to COLLECTIONS with its next repeat after the loan defaults", async () => {
    const d = await leaseWithDevice()
    const first = await ingest(d.deviceId, alertEvent(d.externalDeviceId, ago(5 * HOUR), "TAMPER")) as { alertId: string }
    expect((await database().telematicsAlert.findUniqueOrThrow({ where: { id: first.alertId } })).queue).toBe("SERVICING")
    await asTestSetup([`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, d.loanId])
    const repeat = await ingest(d.deviceId, alertEvent(d.externalDeviceId, ago(HOUR), "TAMPER")) as { alertId: string }
    expect(repeat.alertId).toBe(first.alertId)
    const queue = (await database().telematicsAlert.findUniqueOrThrow({ where: { id: first.alertId } })).queue
    await restore(d.loanId)
    // The collections team works the COLLECTIONS queue: a tamper on a defaulted loan must reach it.
    expect(queue).toBe("COLLECTIONS")
  }, 300_000)

  it("an unresolved alert of the old loan does not swallow the new lease's alert on the same asset", async () => {
    const d = await leaseWithDevice()
    const first = await ingest(d.deviceId, alertEvent(d.externalDeviceId, ago(5 * HOUR), "POWER_CUT")) as { alertId: string }
    await asTestSetup([`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, d.loanId], [`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = $2, "cancelReason" = 'test setup: the old lease is over' WHERE "loanId" = $1`, d.loanId, fx.officer])
    const second = await bookOperatingLease(database(), fx, setSession, d.assetId, 0)
    const repeat = await ingest(d.deviceId, alertEvent(d.externalDeviceId, ago(HOUR), "POWER_CUT")) as { alertId: string }
    const alert = await database().telematicsAlert.findUniqueOrThrow({ where: { id: repeat.alertId } })
    expect(alert.loanId, "the alert of the new lease's tenure sits on the old loan").toBe(second)
    expect(repeat.alertId).not.toBe(first.alertId)
  }, 600_000)

  it("a loan that moves to PENDING_WRITE_OFF (asset not yet recovered) still collects the asset's position", async () => {
    const d = await leaseWithDevice()
    await asTestSetup([`UPDATE "Loan" SET "status" = 'PENDING_WRITE_OFF' WHERE "id" = $1`, d.loanId])
    const outcome = await ingest(d.deviceId, positionEvent(d.externalDeviceId, ago(60_000)))
    await restore(d.loanId)
    expect(outcome).toMatchObject({ stored: true, positionStored: true })
  }, 300_000)

  it("a real provider's meter feeds nothing until staff verify it (METER_UNVERIFIED), then the next day's reading is recorded; verify is once", async () => {
    const real: TelematicsProvider = { ...simulatedTelematics, id: "edge-real", simulated: false, deviceIdError: () => null, assertUsable: () => undefined }
    registerTelematicsProvider(real)
    const assetId = await addAsset(database(), fx)
    const loanId = await bookOperatingLease(database(), fx, setSession, assetId, 30)
    const start = daysAgo(30)
    const ext = `REAL-${nextSeq()}`
    const dev = await database().trackerDevice.create({ data: { tenantId: fx.tenantId, assetId, provider: "edge-real", externalDeviceId: ext, installedOn: new Date(`${start}T00:00:00Z`), createdById: fx.officer } })
    const ingestReal = async (event: ReturnType<typeof meterEvent>) => {
      const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: dev.id } })
      return database().$transaction((tx) => import("./ingest").then((m) => m.ingestEvent(tx as never, device, event, { now: new Date(), simulated: false, retentionDays: 90 })))
    }
    expect(await ingestReal(evening(ext, daysAgo(5), 1_040))).toMatchObject({ meterOutcome: "METER_UNVERIFIED" })
    expect(await verifyTrackerMeter(officer(), dev.id, { note: "" })).toMatchObject({ kind: "refused", status: 400 })
    expect(await verifyTrackerMeter(officer(), dev.id, { note: "Compared on site: both read 1 040 h" })).toMatchObject({ kind: "ok" })
    expect(await verifyTrackerMeter(officer(), dev.id, { note: "Compared on site again" })).toMatchObject({ kind: "refused", status: 409 })
    expect(await ingestReal(evening(ext, daysAgo(4), 1_050))).toMatchObject({ meterOutcome: "RECORDED" })
    expect(await database().assetMeterReading.count({ where: { loanId, source: "TELEMATICS" } })).toBe(1)
  }, 600_000)

  it("a held reading REJECTED for the day leaves room for a same-day corrected event, which is recorded", async () => {
    const d = await leaseWithDevice()
    const day = daysAgo(6)
    expect(await ingest(d.deviceId, evening(d.externalDeviceId, day, ceilingOn(d.start, day) + 5_000))).toMatchObject({ meterOutcome: "HELD" })
    const held = await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: d.loanId } })
    expect(await rejectHeldReading(officer(), held.id, { note: "Device glitch" })).toMatchObject({ kind: "ok" })
    expect(await ingest(d.deviceId, evening(d.externalDeviceId, day, ceilingOn(d.start, day) - 100))).toMatchObject({ meterOutcome: "RECORDED" })
  }, 300_000)

  it("after a rejected hold the day can be held again: one live hold a day, rejected ones aside", async () => {
    const d = await leaseWithDevice()
    const day = daysAgo(6)
    expect(await ingest(d.deviceId, evening(d.externalDeviceId, day, ceilingOn(d.start, day) + 5_000))).toMatchObject({ meterOutcome: "HELD" })
    const held = await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: d.loanId } })
    expect(await rejectHeldReading(officer(), held.id, { note: "Device glitch" })).toMatchObject({ kind: "ok" })
    expect(await ingest(d.deviceId, meterEvent(d.externalDeviceId, new Date(`${day}T17:00:00.000Z`), ceilingOn(d.start, day) + 6_000))).toMatchObject({ meterOutcome: "HELD" })
    expect((await database().telematicsHeldReading.findMany({ where: { loanId: d.loanId }, orderBy: { createdAt: "asc" } })).map((h) => h.status)).toEqual(["REJECTED", "HELD"])
  }, 300_000)

  it("accept needs a real note: blank, two characters and 501 characters are 400 and leave the hold HELD", async () => {
    const d = await leaseWithDevice()
    const day = daysAgo(6)
    await ingest(d.deviceId, evening(d.externalDeviceId, day, ceilingOn(d.start, day) + 5_000))
    const held = await database().telematicsHeldReading.findFirstOrThrow({ where: { loanId: d.loanId } })
    for (const note of ["", "   ", "ab", "x".repeat(501), undefined]) {
      expect(await acceptHeldReading(officer(), held.id, { note })).toMatchObject({ kind: "refused", status: 400 })
    }
    expect((await database().telematicsHeldReading.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("HELD")
  }, 300_000)

  it("a poll over a device whose loan is WRITTEN_OFF does not call the provider", async () => {
    const d = await leaseWithDevice()
    await asTestSetup([`UPDATE "Loan" SET "status" = 'WRITTEN_OFF' WHERE "id" = $1`, d.loanId])
    const spy = vi.spyOn(simulatedTelematics, "poll")
    await pollTenant(fx.tenantId, new Date())
    const touched = spy.mock.calls.some(([input]) => input.devices.some((x) => x.externalDeviceId === d.externalDeviceId))
    spy.mockRestore()
    await restore(d.loanId)
    expect(touched).toBe(false)
  }, 300_000)
})
