/**
 * Helpers for the telematics edge-case suites (edge-cases*.integration.test.ts,
 * docs/asset-finance/SLICE5.md part B): a lease with its own simulated device,
 * a bare device, one event ingested in its own transaction, test setup with
 * the triggers off. Every value is synthetic. Not a test file.
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { paceCeiling } from "@/lib/asset-finance/meter-readings"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SetSession } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { sastCalendarDate } from "@/lib/date/sast"
import { ingestEvent } from "./ingest"
import type { NormalisedTelematicsEvent } from "./types"
import { addAsset, bookOperatingLease, eveningOf, installDevice, meterEvent } from "./telematics.integration-fixture"

const ALLOWANCE = 1_500
const START = 1_000

/** The client and the fixture are read when a helper runs: the suites create both in beforeAll. */
export function edgeHelpers(database: () => PrismaClient, fx: () => LeaseFixture, setSession: SetSession) {
  let seq = 100
  /** A lease booked `daysBack` days back on a fresh asset, with a simulated device installed on its start day. */
  async function leaseWithDevice(daysBack = 30, scenario = "STEADY") {
    const assetId = await addAsset(database(), fx())
    const loanId = await bookOperatingLease(database(), fx(), setSession, assetId, daysBack)
    const start = sastCalendarDate((await database().loan.findUniqueOrThrow({ where: { id: loanId } })).startDate)
    const externalDeviceId = `SIM-${scenario}-${seq++}`
    const deviceId = await installDevice(fx(), assetId, externalDeviceId, start)
    return { assetId, loanId, start, externalDeviceId, deviceId }
  }
  /** A bare asset (no lease) with a simulated device installed on `installedOn`. */
  async function bareDevice(installedOn: string, scenario = "STEADY") {
    const assetId = await addAsset(database(), fx())
    const externalDeviceId = `SIM-${scenario}-${seq++}`
    const deviceId = await installDevice(fx(), assetId, externalDeviceId, installedOn)
    return { assetId, externalDeviceId, deviceId }
  }
  async function ingest(deviceId: string, event: NormalisedTelematicsEvent, opts: { now?: Date; retentionDays?: number } = {}) {
    const device = await database().trackerDevice.findUniqueOrThrow({ where: { id: deviceId } })
    return database().$transaction((tx) => ingestEvent(tx as never, device, event, { now: opts.now ?? new Date(), simulated: true, retentionDays: opts.retentionDays ?? 90 }))
  }
  async function asTestSetup(...statements: [string, ...unknown[]][]) {
    await database().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      for (const [sql, ...params] of statements) await tx.$executeRawUnsafe(sql, ...params)
    })
  }
  const readings = async (loanId: string) =>
    (await database().assetMeterReading.findMany({ where: { loanId, source: "TELEMATICS" }, orderBy: { readingDate: "asc" } })).map((r) => ({ date: isoOfDbDate(r.readingDate), value: r.value }))
  return { leaseWithDevice, bareDevice, ingest, asTestSetup, readings, nextSeq: () => seq++ }
}

export const ceilingOn = (start: string, day: string) => paceCeiling({ value: START, readingDate: start }, day, ALLOWANCE)
/** An 18:00 SAST meter event on `day` for a device. */
export const evening = (ext: string, day: string, value: number) => meterEvent(ext, eveningOf(day), value)
export const heartbeat = (ext: string, at: Date, id = randomUUID()): NormalisedTelematicsEvent => ({ providerEventId: `it:${id}`, externalDeviceId: ext, occurredAt: at, kind: "HEARTBEAT" })
export const positionEvent = (ext: string, at: Date): NormalisedTelematicsEvent => ({
  providerEventId: `it:${randomUUID()}`, externalDeviceId: ext, occurredAt: at, kind: "POSITION", position: { latitude: -35.01, longitude: 20.01, accuracyM: 10 },
})
