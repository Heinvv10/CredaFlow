/**
 * A tracker whose meter is offset from the asset's (architecture review of
 * PR #222, inverted to the fixed behaviour). Above the true meter but under
 * the pace ceiling, an unattended reading would floor every later staff
 * reading (monotonic), so the true reading could never be recorded. So a real
 * provider's device feeds no lease reading until staff verify its meter
 * against the asset's own (METER_UNVERIFIED; guardTelematicsMeterReading
 * refuses it too), and a low device holds one reading a day, not one per
 * event.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/meter-offset.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient, TrackerDevice } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { recordMeterReading } from "@/lib/asset-finance/meter-readings"
import { dbDate } from "@/lib/asset-finance/dates"
import { ruleRefuses } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { ingestEvent } from "./ingest"
import { registerTrackerDevice, verifyTrackerMeter } from "./devices"
import { registerTelematicsProvider } from "./registry"
import {
  bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, eveningOf, installDevice, meterEvent, telematicsTestClient, today,
} from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let loanId: string
let device: TrackerDevice
let lowDevice: TrackerDevice
let lowLoanId: string

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const ingest = async (d: TrackerDevice, value: number, at: Date) => {
  const fresh = await database().trackerDevice.findUniqueOrThrow({ where: { id: d.id } })
  return database().$transaction((tx) => ingestEvent(tx as never, fresh, meterEvent(d.externalDeviceId, at, value), { now: new Date(), simulated: fresh.provider === "simulated", retentionDays: 90 }))
}
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` })

registerTelematicsProvider({
  id: "acme-meter", label: "A real provider (test double)", simulated: false,
  deviceIdError: () => null, assertUsable: () => undefined, poll: async () => ({ events: [], cursors: {}, simulated: false }),
})

suite.sequential("device meter offset (real DB)", () => {
  beforeAll(async () => {
    fx = await createTelematicsFixture(database(), t)
    loanId = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    lowLoanId = await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    const real = await registerTrackerDevice(officer(), fx.assets[1], { provider: "acme-meter", externalDeviceId: "ACME-71", installedOn: daysAgo(30) })
    device = await database().trackerDevice.findUniqueOrThrow({ where: { id: (real as { id: string }).id } })
    lowDevice = await database().trackerDevice.findUniqueOrThrow({ where: { id: await installDevice(fx, fx.assets[2], "SIM-STEADY-72", daysAgo(30)) } })
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("an unverified real device writes no reading, so the true staff reading still goes in; verified, its next reading is written", async () => {
    // True meter ~1 060 h; the device reads 400 h high, still under the pace ceiling (~1 629 h).
    expect(await ingest(device, 1_460, eveningOf(daysAgo(10)))).toMatchObject({ stored: true, meterOutcome: "METER_UNVERIFIED" })
    expect(await database().assetMeterReading.count({ where: { loanId, source: "TELEMATICS" } })).toBe(0)
    // The database refuses it as well: a non-simulated event of an unverified device.
    const unverified = await database().telematicsEvent.findFirstOrThrow({ where: { deviceId: device.id, meterOutcome: "METER_UNVERIFIED" } })
    await ruleRefuses(database(), { fn: "guardTelematicsMeterReading", replace: [`IF NOT ev."simulated" AND ev."meterVerifiedAt" IS NULL THEN`, `IF FALSE THEN`] },
      /from a simulated event or a device whose meter staff verified/,
      (tx) => tx.assetMeterReading.create({ data: {
        tenantId: fx.tenantId, assetId: fx.assets[1], loanId, readingDate: dbDate(daysAgo(10)), value: 1_460, unit: "HOURS", source: "TELEMATICS", telematicsEventId: unverified.id,
      } }))
    const staff = await database().$transaction((tx) => recordMeterReading(tx as never, { tenantId: fx.tenantId, userId: fx.officer }, {
      loanId, readingDate: daysAgo(9), value: 1_065, evidenceDocumentId: null, today: today(),
    }))
    expect(staff).toMatchObject({ kind: "recorded" })
    // Verification is a note, once, audited.
    expect(await verifyTrackerMeter(officer(), device.id, { note: "x" })).toMatchObject({ kind: "refused", status: 400 })
    expect(await verifyTrackerMeter(officer(), device.id, { note: "Dashboard 1 070 h, device 1 070 h on site" })).toMatchObject({ kind: "ok" })
    expect(await verifyTrackerMeter(officer(), device.id, { note: "Again" })).toMatchObject({ kind: "refused", status: 409 })
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TRACKER_METER_VERIFIED", entityId: device.id } })).toBe(1)
    expect(await ingest(device, 1_072, eveningOf(daysAgo(8)))).toMatchObject({ stored: true, meterOutcome: "RECORDED" })
  }, 120_000)

  it("holds one low METER event a day; the rest of that day are device readings only", async () => {
    await database().$transaction((tx) => recordMeterReading(tx as never, { tenantId: fx.tenantId, userId: fx.officer }, {
      loanId: lowLoanId, readingDate: daysAgo(12), value: 1_050, evidenceDocumentId: null, today: today(),
    }))
    const day = daysAgo(5)
    const outcomes = []
    for (const hour of [8, 10, 12, 14]) {
      outcomes.push((await ingest(lowDevice, 40 + hour, new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`))) as { meterOutcome?: string })
    }
    expect(outcomes.map((o) => o.meterOutcome)).toEqual(["HELD", "SAME_DAY", "SAME_DAY", "SAME_DAY"])
    expect(await database().telematicsHeldReading.count({ where: { loanId: lowLoanId, status: "HELD" } })).toBe(1)
  }, 120_000)
})
