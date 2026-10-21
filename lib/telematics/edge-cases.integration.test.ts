/**
 * Edge cases of the telematics ingest on real Postgres (docs/asset-finance/SLICE5.md
 * part B): day, pace, term and clock boundaries, paging, retention and the
 * purge. The device, alert and held-reading edges are in
 * edge-cases-ingest.integration.test.ts.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/edge-cases.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate, fromDayNumber, toDayNumber } from "@/lib/asset-finance/dates"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { SAST_OFFSET_MS, sastCalendarDate } from "@/lib/date/sast"
import { pollTenant } from "./poll"
import { purgeTelematicsPositions } from "./purge"
import { simulatedTelematics, SIMULATED_PAGE_SIZE } from "./providers/simulated"
import { TelematicsEventNotYet } from "./event-shape"
import { ceilingOn, edgeHelpers, evening, heartbeat, positionEvent } from "./edge.integration-fixture"
import { cleanupTelematicsFixture, createTelematicsFixture, daysAgo, meterEvent, telematicsTestClient, today } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
// Every lease here is signed by the same lessee; the portal signing limit is per process and is not under test.
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
const DAY_MS = 86_400_000
const { leaseWithDevice, bareDevice, ingest, asTestSetup, readings } = edgeHelpers(database, () => fx, (user) => { session.current = user && { user } })

suite.sequential("telematics edge cases: days, clocks, paging, retention (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
  }, 600_000)
  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)
  afterEach(() => vi.restoreAllMocks())

  it("SAST day boundary: 23:59:59.999 SAST is that day's reading, 00:00:00 SAST the next day's", async () => {
    const l = await leaseWithDevice()
    const d = daysAgo(10)
    const lastMs = new Date(`${d}T21:59:59.999Z`)
    const midnight = new Date(lastMs.getTime() + 1)
    expect(sastCalendarDate(lastMs)).toBe(d)
    expect(sastCalendarDate(midnight)).toBe(daysAgo(9))
    expect(await ingest(l.deviceId, meterEvent(l.externalDeviceId, lastMs, 1_100))).toMatchObject({ stored: true, meterOutcome: "RECORDED" })
    expect(await ingest(l.deviceId, meterEvent(l.externalDeviceId, midnight, 1_110))).toMatchObject({ stored: true, meterOutcome: "RECORDED" })
    expect(await readings(l.loanId)).toEqual([{ date: d, value: 1_100 }, { date: daysAgo(9), value: 1_110 }])
  }, 300_000)

  it("pace ceiling equality: value == ceiling is recorded, ceiling + 1 is held (TS and SQL agree)", async () => {
    const l = await leaseWithDevice()
    const a = daysAgo(8)
    const b = daysAgo(7)
    expect(await ingest(l.deviceId, evening(l.externalDeviceId, a, ceilingOn(l.start, a)))).toMatchObject({ meterOutcome: "RECORDED" })
    expect(await ingest(l.deviceId, evening(l.externalDeviceId, b, ceilingOn(l.start, b) + 1))).toMatchObject({ meterOutcome: "HELD" })
    const sql = await database().$queryRaw<{ c: number }[]>`SELECT public."telematicsPaceCeiling"(${fx.tenantId}, ${l.loanId}, ${dbDate(b)}::date) AS c`
    expect(sql[0].c).toBe(ceilingOn(l.start, b))
    for (let n = 0; n < 400; n++) {
      const day = fromDayNumber(toDayNumber(l.start) + n)
      const row = await database().$queryRaw<{ c: number }[]>`SELECT public."telematicsPaceCeiling"(${fx.tenantId}, ${l.loanId}, ${dbDate(day)}::date) AS c`
      expect(row[0].c, day).toBe(ceilingOn(l.start, day))
    }
  }, 300_000)

  it("lease term end: a reading one day before is recorded, one exactly on it is not", async () => {
    const l = await leaseWithDevice()
    const end = daysAgo(3)
    await asTestSetup([`UPDATE "LeaseRental" SET "dueDate" = LEAST("dueDate", $2::date) WHERE "loanId" = $1`, l.loanId, end])
    expect(await ingest(l.deviceId, evening(l.externalDeviceId, daysAgo(4), 1_050))).toMatchObject({ meterOutcome: "RECORDED" })
    expect(await ingest(l.deviceId, evening(l.externalDeviceId, end, 1_060))).toMatchObject({ meterOutcome: "LEASE_NOT_RUNNING" })
    expect(await ingest(l.deviceId, evening(l.externalDeviceId, daysAgo(2), 1_070))).toMatchObject({ meterOutcome: "LEASE_NOT_RUNNING" })
    expect((await readings(l.loanId)).map((r) => r.date)).toEqual([daysAgo(4)])
  }, 300_000)

  it("start reading missing (unreachable through booking): no ceiling applies, so the reading is recorded (a known limitation)", async () => {
    const l = await leaseWithDevice()
    await asTestSetup([`DELETE FROM "AssetMeterReading" WHERE "loanId" = $1`, l.loanId])
    expect(await ingest(l.deviceId, evening(l.externalDeviceId, daysAgo(5), 2_000_000_000))).toMatchObject({ stored: true, meterOutcome: "RECORDED" })
  }, 300_000)

  it("future events: 4m50s ahead is stored, 6 minutes ahead is the database's \"not yet\" (deferred by the poll, never dropped)", async () => {
    const d = await bareDevice(today())
    const soon = new Date(Date.now() + 290_000)
    expect(await ingest(d.deviceId, heartbeat(d.externalDeviceId, soon))).toMatchObject({ stored: true })
    await expect(ingest(d.deviceId, heartbeat(d.externalDeviceId, new Date(Date.now() + 360_000)))).rejects.toThrow(TelematicsEventNotYet)
  }, 300_000)

  it("an event ahead of the poll's clock waits (cursor kept) and is recorded by the next poll, never lost as 'lease not running'", async () => {
    const l = await leaseWithDevice()
    const at = new Date(Date.now() + 60_000)
    const event = meterEvent(l.externalDeviceId, at, 1_020)
    vi.spyOn(simulatedTelematics, "poll").mockResolvedValue({ events: [event], cursors: { [l.externalDeviceId]: at.toISOString() }, simulated: true })
    expect(await pollTenant(fx.tenantId, new Date(at.getTime() - 60_000))).toMatchObject({ deferred: 1, stored: 0, ok: true })
    expect(await database().telematicsEvent.count({ where: { deviceId: l.deviceId } })).toBe(0)
    expect((await database().trackerDevice.findUniqueOrThrow({ where: { id: l.deviceId } })).pollCursor).toBeNull()
    expect(await pollTenant(fx.tenantId, new Date(at.getTime() + 60_000))).toMatchObject({ deferred: 0, stored: 1, ok: true })
    expect(await database().telematicsEvent.findFirstOrThrow({ where: { deviceId: l.deviceId } })).toMatchObject({ meterOutcome: "RECORDED" })
    expect((await database().trackerDevice.findUniqueOrThrow({ where: { id: l.deviceId } })).pollCursor).toBe(at.toISOString())
  }, 300_000)

  it("cursor paging: exactly 500 events, then an empty page; 501 events pages 500 + 1; nothing lost or repeated", async () => {
    const installed = daysAgo(400)
    const at = (day: number, hour: number) => new Date((toDayNumber(installed) + day) * DAY_MS + hour * 3_600_000 - SAST_OFFSET_MS)
    const run = async (now: Date) => {
      const seen: string[] = []
      let cursor: string | null = null
      const sizes: number[] = []
      for (let i = 0; i < 4; i++) {
        const r = await simulatedTelematics.poll({ devices: [{ externalDeviceId: "SIM-STEADY-1", cursor, installedOn: installed }], now })
        sizes.push(r.events.length)
        seen.push(...r.events.map((e) => e.providerEventId))
        cursor = r.cursors["SIM-STEADY-1"] ?? cursor
        if (r.events.length === 0) break
      }
      expect(new Set(seen).size).toBe(seen.length)
      return { sizes, seen }
    }
    expect(SIMULATED_PAGE_SIZE).toBe(500)
    expect((await run(at(166, 12))).sizes).toEqual([500, 0])
    const r501 = await run(at(166, 18))
    expect(r501.sizes).toEqual([500, 1, 0])
    expect(r501.seen.length).toBe(501)
  })

  it("an empty poll (no devices) is ok; a SILENT device stops after day 5 and raises nothing", async () => {
    const empty = await pollTenant(`no-such-tenant-${t}`, new Date())
    expect(empty).toMatchObject({ ok: true, devices: 0, stored: 0 })
    const installed = daysAgo(20)
    const r = await simulatedTelematics.poll({ devices: [{ externalDeviceId: "SIM-SILENT-1", cursor: null, installedOn: installed }], now: new Date() })
    expect(r.events.length).toBe(6 * 3)
    expect(r.events.some((e) => e.kind === "ALERT")).toBe(false)
    const again = await simulatedTelematics.poll({ devices: [{ externalDeviceId: "SIM-SILENT-1", cursor: r.cursors["SIM-SILENT-1"], installedOn: installed }], now: new Date() })
    expect(again.events).toEqual([])
    expect(again.cursors).toEqual({})
  })

  it("retention edge: a position at exactly N days (and within the 60 s edge) is not stored; past the edge it is", async () => {
    const l = await leaseWithDevice()
    const now = new Date()
    const base = now.getTime() - 10 * DAY_MS
    const opts = { now, retentionDays: 10 }
    expect(await ingest(l.deviceId, positionEvent(l.externalDeviceId, new Date(base)), opts)).toMatchObject({ stored: true, positionStored: false })
    expect(await ingest(l.deviceId, positionEvent(l.externalDeviceId, new Date(base + 30_000)), opts)).toMatchObject({ stored: true, positionStored: false })
    expect(await ingest(l.deviceId, positionEvent(l.externalDeviceId, new Date(base + 90_000)), opts)).toMatchObject({ stored: true, positionStored: true })
  }, 300_000)

  it("only the latest position is kept: a newer one replaces it, an older or equal one is not stored", async () => {
    const l = await leaseWithDevice()
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
    const first = await ingest(l.deviceId, positionEvent(l.externalDeviceId, at(30)))
    expect(first).toMatchObject({ positionStored: true })
    expect(await ingest(l.deviceId, positionEvent(l.externalDeviceId, at(40)))).toMatchObject({ stored: true, positionStored: false })
    const newer = await ingest(l.deviceId, positionEvent(l.externalDeviceId, at(20)))
    expect(newer).toMatchObject({ positionStored: true })
    const rows = await database().telematicsPosition.findMany({ where: { deviceId: l.deviceId } })
    expect(rows.map((r) => r.eventId)).toEqual([(newer as { eventId: string }).eventId])
  }, 300_000)

  it("purge: the device's position a minute past N days goes (with its position event); one an hour inside stays", async () => {
    const l = await leaseWithDevice()
    const make = async () => (await ingest(l.deviceId, positionEvent(l.externalDeviceId, new Date(Date.now() - 60_000))) as { eventId: string }).eventId
    const age = (eventId: string, interval: string) => asTestSetup(
      [`UPDATE "TelematicsEvent" SET "occurredAt" = (now() AT TIME ZONE 'UTC') - interval '90 days' ${interval} WHERE "id" = $1`, eventId],
      [`UPDATE "TelematicsPosition" SET "occurredAt" = (now() AT TIME ZONE 'UTC') - interval '90 days' ${interval} WHERE "eventId" = $1`, eventId])
    const old = await make()
    await age(old, "- interval '1 minute'")
    expect(await purgeTelematicsPositions()).toMatchObject({ ok: true })
    expect(await database().telematicsPosition.count({ where: { eventId: old } })).toBe(0)
    expect(await database().telematicsEvent.count({ where: { id: old } })).toBe(0)
    const fresh = await make()
    await age(fresh, "+ interval '1 hour'")
    expect(await purgeTelematicsPositions()).toMatchObject({ ok: true })
    expect(await database().telematicsPosition.count({ where: { eventId: fresh } })).toBe(1)
  }, 300_000)
})
