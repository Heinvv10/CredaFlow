/**
 * Edge-case probes for part T (theft report, SQL purpose gate, position trail)
 * on real Postgres. Synthetic data only.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 TENANT_RLS=on DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/telematics/edge-followups.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleRefuses, testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import { sastCalendarDate } from "@/lib/date/sast"
import { positionPurposes } from "./position-purpose"
import { purgeTelematicsPositions } from "./purge"
import { revealPosition } from "./position-view"
import { revealPositionTrail, TRAIL_LIMIT } from "./position-trail"
import { confirmTheftReport, recordTheftReport } from "./theft-reports"
import { removeTrackerDevice } from "./devices"
import { addAsset, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient, today } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let collectorId = ""
let secondId = ""
const meta = { ipAddress: "192.0.2.77", userAgent: "telematics-edge-it" }
const DAY = 86_400_000
const MIN = 60_000

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const collector = () => ({ tenantId: fx.tenantId, userId: collectorId, userEmail: `${collectorId}@telematics-edge.test`, role: "COLLECTIONS_OFFICER" })
/** Records a theft report as the collector and, once recorded, has a second collector confirm it (THEFT holds only then). */
async function reportConfirmed(loanId: string, body: Record<string, unknown>) {
  const recorded = await recordTheftReport(collector(), loanId, body)
  if (recorded.kind === "ok") {
    const second = { tenantId: fx.tenantId, userId: secondId, userEmail: `${secondId}@telematics-edge.test`, role: "COLLECTIONS_OFFICER" }
    expect(await confirmTheftReport(second, loanId, recorded.reportId)).toEqual({ kind: "ok" })
  }
  return recorded
}
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-edge.test` })
const caseNo = (n: number) => `CAS ${n}/${Number(today().slice(5, 7))}/${today().slice(0, 4)}`

/** A fresh asset, leased `daysBack` days ago, with a simulated device installed at the loan's start. */
async function lease(daysBack: number, deviceLabel: string): Promise<{ loanId: string; assetId: string; deviceId: string }> {
  _resetRateLimitStore()
  const assetId = await addAsset(database(), fx)
  const loanId = await bookOperatingLease(database(), fx, setSession, assetId, daysBack)
  const deviceId = await installDevice(fx, assetId, deviceLabel, daysAgo(daysBack))
  return { loanId, assetId, deviceId }
}
/** Positions at the given instants for a device (event + position, written with the triggers off: only the reads are under test). */
async function addPositions(deviceId: string, instants: Date[]): Promise<string[]> {
  const ids = instants.map(() => randomUUID())
  for (const [i, at] of instants.entries()) {
    await testSetup(database(),
      [`INSERT INTO "TelematicsEvent" ("id", "tenantId", "deviceId", "provider", "providerEventId", "kind", "occurredAt", "simulated")
        VALUES ($1, $2, $3, 'simulated', $4, 'POSITION', $5::timestamp, true)`, `ev_${ids[i]}`, fx.tenantId, deviceId, `edge:${ids[i]}`, at.toISOString()],
      [`INSERT INTO "TelematicsPosition" ("id", "tenantId", "eventId", "deviceId", "occurredAt", "latitude", "longitude", "accuracyM")
        VALUES ($1, $2, $3, $4, $5::timestamp, -26.2, 28.0, 5)`, `tp_${ids[i]}`, fx.tenantId, `ev_${ids[i]}`, deviceId, at.toISOString()])
  }
  return ids.map((id) => `tp_${id}`)
}
/** n positions a minute apart ending `endMinutesAgo` minutes ago, in one statement. */
async function addPositionRun(deviceId: string, n: number, endMinutesAgo: number): Promise<void> {
  const tag = randomUUID().slice(0, 8)
  await testSetup(database(),
    [`INSERT INTO "TelematicsEvent" ("id", "tenantId", "deviceId", "provider", "providerEventId", "kind", "occurredAt", "simulated")
      SELECT 'ev_${tag}_' || g, $1, $2, 'simulated', 'edge:${tag}:' || g, 'POSITION', (now() AT TIME ZONE 'UTC') - ((($4::int - g) + $3::int) || ' minutes')::interval, true
      FROM generate_series(1, $4::int) g`, fx.tenantId, deviceId, endMinutesAgo, n],
    [`INSERT INTO "TelematicsPosition" ("id", "tenantId", "eventId", "deviceId", "occurredAt", "latitude", "longitude", "accuracyM")
      SELECT 'tp_${tag}_' || g, $1, 'ev_${tag}_' || g, $2, e."occurredAt", -26.2, 28.0, 5 FROM generate_series(1, $3::int) g
      JOIN "TelematicsEvent" e ON e."id" = 'ev_${tag}_' || g`, fx.tenantId, deviceId, n])
}
const legalMatter = (loanId: string) =>
  testSetup(database(), [`INSERT INTO "LegalMatter" ("id", "tenantId", "loanId", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, now())`, `lm_${randomUUID()}`, fx.tenantId, loanId, fx.adminA])
const trail = (loanId: string, context: "THEFT" | "LEGAL_MATTER" | "RECOVERY" = "LEGAL_MATTER") => revealPositionTrail(collector(), loanId, { context }, meta)
type Points = { kind: "ok"; points: { occurredAt: string }[]; truncated: boolean }

suite.sequential("part T edge probes: theft report, purpose gate, trail (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    collectorId = (await database().user.create({ data: { tenantId: fx.tenantId, email: `edge-collector-${t}@staff.invalid`, password: "x", role: "COLLECTIONS_OFFICER" } })).id
    secondId = (await database().user.create({ data: { tenantId: fx.tenantId, email: `edge-second-${t}@staff.invalid`, password: "x", role: "COLLECTIONS_OFFICER" } })).id
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 120_000)

  afterEach(() => {
    vi.useRealTimers()
  })

  it("theft reported on the day the loan starts: recorded, THEFT revealed, trail starts at the loan start (a fix a minute earlier is not shown)", async () => {
    const { loanId, deviceId } = await lease(0, "SIM-STEADY-1")
    const loan = await database().loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(sastCalendarDate(loan.startDate)).toBe(today())
    const recorded = await reportConfirmed(loanId, { sapsCaseNumber: caseNo(1101), reportedOn: today() })
    expect(recorded).toMatchObject({ kind: "ok" })
    await addPositions(deviceId, [new Date(loan.startDate.getTime() - MIN), new Date(loan.startDate.getTime() + MIN), new Date(loan.startDate.getTime() + 2 * MIN)])
    expect(await revealPosition(collector(), loanId, { context: "THEFT" }, meta)).toMatchObject({ kind: "ok" })
    const shown = (await trail(loanId, "THEFT")) as Points
    expect(shown).toMatchObject({ kind: "ok", truncated: false })
    expect(shown.points.map((p) => p.occurredAt)).toEqual([new Date(loan.startDate.getTime() + MIN).toISOString(), new Date(loan.startDate.getTime() + 2 * MIN).toISOString()])
  }, 900_000)

  it("a theft reported the day BEFORE the loan started is refused by the database (409), and the SQL trigger is what refuses it", async () => {
    const { loanId } = await lease(0, "SIM-STEADY-2")
    const refused = await reportConfirmed(loanId, { sapsCaseNumber: caseNo(1102), reportedOn: daysAgo(1) })
    expect(refused).toMatchObject({ kind: "refused", status: 409 })
    expect(await database().assetTheftReport.count({ where: { tenantId: fx.tenantId, loanId } })).toBe(0)
  }, 900_000)

  it("validity boundary at SAST midnight: valid through 21:59:59Z on its last day, gone at 22:00:00Z (TypeScript reader); SQL and TypeScript agree on today now", async () => {
    const { loanId } = await lease(5, "SIM-STEADY-3")
    const [sqlToday] = await database().$queryRawUnsafe<{ d: string }[]>(`SELECT ((now() AT TIME ZONE 'Africa/Johannesburg')::date)::text AS d`)
    expect(sqlToday.d).toBe(today())
    await testSetup(database(), [`INSERT INTO "AssetTheftReport" ("id", "tenantId", "loanId", "assetId", "sapsCaseNumber", "reportedOn", "validUntil", "recordedById", "confirmedById", "confirmedAt")
      SELECT 'tr_${t}_mid', $1, l."id", l."assetId", 'CAS 1103/6/2026', '2030-05-20', '2030-06-15', $3, $4, now() FROM "Loan" l WHERE l."id" = $2`, fx.tenantId, loanId, collectorId, secondId])
    const loan = { id: loanId, status: "ACTIVE" }
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2030-06-15T21:59:59Z"))
    expect((await positionPurposes(fx.tenantId, loan)).THEFT).toBe(true)
    vi.setSystemTime(new Date("2030-06-15T22:00:00Z"))
    expect((await positionPurposes(fx.tenantId, loan)).THEFT).toBe(false)
    vi.useRealTimers()
    // The SQL definition, at the real clock: validUntil = SAST today holds, SAST yesterday does not.
    const holds = async (validUntil: string) => {
      await testSetup(database(), [`UPDATE "AssetTheftReport" SET "validUntil" = $2::date WHERE "id" = $1`, `tr_${t}_mid`, validUntil])
      const [row] = await database().$queryRawUnsafe<{ h: boolean }[]>(`SELECT "telematicsPurposeHolds"($1, $2, 'THEFT', $3) AS h`, fx.tenantId, loanId, `tr_${t}_mid`)
      return row.h
    }
    expect(await holds(today())).toBe(true)
    expect(await holds(daysAgo(1))).toBe(false)
  }, 900_000)

  it("a renewal chain A <- B <- C of one case is admitted, each valid 30 days from its own recording; a renewal naming another loan's report is refused", async () => {
    const a = await lease(10, "SIM-STEADY-4")
    const b = await lease(10, "SIM-STEADY-5")
    const first = await reportConfirmed(a.loanId, { sapsCaseNumber: caseNo(1104), reportedOn: daysAgo(3) })
    const second = await reportConfirmed(a.loanId, { sapsCaseNumber: caseNo(1104), reportedOn: daysAgo(3), renewsReportId: (first as { reportId: string }).reportId })
    const third = await reportConfirmed(a.loanId, { sapsCaseNumber: caseNo(1104), reportedOn: daysAgo(3), renewsReportId: (second as { reportId: string }).reportId })
    expect([first, second, third].map((r) => r.kind)).toEqual(["ok", "ok", "ok"])
    const other = await reportConfirmed(b.loanId, { sapsCaseNumber: caseNo(1104), reportedOn: daysAgo(3), renewsReportId: (first as { reportId: string }).reportId })
    expect(other).toMatchObject({ kind: "refused", status: 409 })
    // Whichever of the three the purpose names, the reveal answers and logs a report of this loan.
    expect(await revealPosition(collector(), a.loanId, { context: "THEFT" }, meta)).toMatchObject({ kind: "ok" })
    const logged = await database().telematicsPositionAccess.findFirstOrThrow({ where: { loanId: a.loanId } })
    expect([first, second, third].map((r) => (r as { reportId: string }).reportId)).toContain(logged.theftReportId)
  }, 900_000)

  it("a renewal keeps the original report's date, whatever date is sent, so it cannot move the THEFT trail window", async () => {
    const { loanId } = await lease(20, "SIM-STEADY-6")
    const original = await reportConfirmed(loanId, { sapsCaseNumber: caseNo(1105), reportedOn: daysAgo(1) })
    const renewed = await reportConfirmed(loanId, { sapsCaseNumber: caseNo(1105), reportedOn: daysAgo(19), renewsReportId: (original as { reportId: string }).reportId })
    expect(renewed).toMatchObject({ kind: "ok" })
    const row = await database().assetTheftReport.findUniqueOrThrow({ where: { id: (renewed as { reportId: string }).reportId } })
    expect(row.reportedOn.toISOString().slice(0, 10)).toBe(daysAgo(1))
  }, 900_000)

  it("a loan whose asset was re-leased: the completed lease takes no report; the new lease's trail holds only its own tenure", async () => {
    _resetRateLimitStore()
    const assetId = await addAsset(database(), fx)
    const first = await bookOperatingLease(database(), fx, setSession, assetId, 40)
    const deviceId = await installDevice(fx, assetId, "SIM-STEADY-7", daysAgo(40))
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() - INTERVAL '10 days' WHERE "id" = $1`, first])
    // The app books no second lease of an asset whose deal is still BOOKED, so the new lease is booked on another asset and pointed at this one (test setup).
    _resetRateLimitStore()
    const otherAsset = await addAsset(database(), fx)
    const second = await bookOperatingLease(database(), fx, setSession, otherAsset, 5)
    await testSetup(database(), [`UPDATE "Loan" SET "assetId" = $2 WHERE "id" = $1`, second, assetId])
    const startOfSecond = (await database().loan.findUniqueOrThrow({ where: { id: second } })).startDate
    await addPositions(deviceId, [new Date(Date.now() - 20 * DAY), new Date(Date.now() - 12 * DAY), new Date(startOfSecond.getTime() + 2 * MIN)])
    expect(await reportConfirmed(first, { sapsCaseNumber: caseNo(1106), reportedOn: daysAgo(1) })).toMatchObject({ kind: "refused", status: 409 })
    expect(await reportConfirmed(second, { sapsCaseNumber: caseNo(1106), reportedOn: daysAgo(1) })).toMatchObject({ kind: "ok" })
    expect(await revealPosition(collector(), first, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    const shown = (await trail(second, "THEFT")) as Points
    expect(shown.points.map((p) => p.occurredAt)).toEqual([new Date(startOfSecond.getTime() + 2 * MIN).toISOString()])
    // The old lease, with a legal matter, sees only its own tenure (to its end), not the new lessee's movements.
    await legalMatter(first)
    const old = (await trail(first)) as Points
    expect(old.points).toHaveLength(2)
    expect(old.points.every((p) => Date.parse(p.occurredAt) < startOfSecond.getTime())).toBe(true)
  }, 1_200_000)

  it("a device swapped mid-tenure: the trail spans both devices in time order; the access row names the newest point's device", async () => {
    const { loanId, assetId, deviceId: first } = await lease(30, "SIM-STEADY-8")
    await legalMatter(loanId)
    const before = [new Date(Date.now() - 20 * DAY), new Date(Date.now() - 15 * DAY)]
    await addPositions(first, before)
    expect(await removeTrackerDevice(officer(), first, {})).toEqual({ kind: "ok" })
    const second = await installDevice(fx, assetId, "SIM-STEADY-9", daysAgo(12))
    const after = [new Date(Date.now() - 10 * DAY), new Date(Date.now() - 5 * DAY)]
    await addPositions(second, after)
    const shown = (await trail(loanId)) as Points
    expect(shown.points.map((p) => p.occurredAt)).toEqual([...before, ...after].map((d) => d.toISOString()))
    const row = await database().telematicsPositionAccess.findFirstOrThrow({ where: { loanId, view: "TRAIL" } })
    expect(row).toMatchObject({ deviceId: second, positionCount: 4 })
  }, 900_000)

  it("exactly TRAIL_LIMIT points is not truncated; TRAIL_LIMIT + 1 is, drops the OLDEST, and says so in the audit", async () => {
    const { loanId, deviceId } = await lease(30, "SIM-STEADY-10")
    await legalMatter(loanId)
    await addPositionRun(deviceId, TRAIL_LIMIT, 60)
    const exact = (await trail(loanId)) as Points
    expect(exact).toMatchObject({ kind: "ok", truncated: false })
    expect(exact.points).toHaveLength(TRAIL_LIMIT)
    const oldestOfExact = exact.points[0].occurredAt
    await addPositionRun(deviceId, 1, 60 + TRAIL_LIMIT) // one point older than all of them
    const over = (await trail(loanId)) as Points
    expect(over).toMatchObject({ kind: "ok", truncated: true })
    expect(over.points).toHaveLength(TRAIL_LIMIT)
    expect(over.points[0].occurredAt).toBe(oldestOfExact)
    const times = over.points.map((p) => Date.parse(p.occurredAt))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    const audit = await database().auditLog.findFirstOrThrow({ where: { tenantId: fx.tenantId, entityId: loanId, action: "TELEMATICS_POSITION_TRAIL_VIEWED" }, orderBy: { createdAt: "desc" } })
    expect(audit.newValue).toMatchObject({ points: TRAIL_LIMIT, truncated: true })
    expect(await database().telematicsPositionAccess.findFirstOrThrow({ where: { loanId, view: "TRAIL" }, orderBy: { createdAt: "desc" } })).toMatchObject({ positionCount: TRAIL_LIMIT })
  }, 900_000)

  it("an empty trail (no positions) still logs a TRAIL row with count 0,", async () => {
    const { loanId } = await lease(10, "SIM-STEADY-11")
    await legalMatter(loanId)
    const empty = (await trail(loanId)) as Points
    expect(empty).toMatchObject({ kind: "ok", points: [], truncated: false })
    expect(await database().telematicsPositionAccess.findFirstOrThrow({ where: { loanId, view: "TRAIL" } })).toMatchObject({ positionCount: 0 })
  }, 900_000)

  it("retention changed between view and purge: a shorter retention hides older fixes at once, the purge then deletes them, a longer retention does not bring them back", async () => {
    const { loanId, deviceId } = await lease(60, "SIM-STEADY-12")
    await legalMatter(loanId)
    await addPositions(deviceId, [new Date(Date.now() - 50 * DAY), new Date(Date.now() - 20 * DAY), new Date(Date.now() - 2 * DAY)])
    const setRetention = (days: number) => database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: days } })
    try {
      expect(((await trail(loanId)) as Points).points).toHaveLength(3)
      await setRetention(30)
      expect(((await trail(loanId)) as Points).points).toHaveLength(2)
      expect(await purgeTelematicsPositions()).toMatchObject({ ok: true })
      expect(await database().telematicsPosition.count({ where: { tenantId: fx.tenantId, deviceId } })).toBe(2)
      await setRetention(90)
      expect(((await trail(loanId)) as Points).points).toHaveLength(2)
      await setRetention(1)
      expect(((await trail(loanId)) as Points).points).toHaveLength(0)
    } finally {
      await setRetention(90)
    }
  }, 900_000)

  it("a LATEST access row naming a position that is later purged does not stop the purge", async () => {
    const { loanId, deviceId } = await lease(60, "SIM-STEADY-13")
    await legalMatter(loanId)
    const [id] = await addPositions(deviceId, [new Date(Date.now() - 50 * DAY)])
    expect(await revealPosition(collector(), loanId, { context: "LEGAL_MATTER" }, meta)).toMatchObject({ kind: "ok" })
    expect(await database().telematicsPositionAccess.findFirstOrThrow({ where: { loanId, view: "LATEST" } })).toMatchObject({ positionId: id })
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = "occurredAt" - INTERVAL '45 days' WHERE "id" = $1`, id],
      [`UPDATE "TelematicsEvent" SET "occurredAt" = "occurredAt" - INTERVAL '45 days' WHERE "id" = (SELECT "eventId" FROM "TelematicsPosition" WHERE "id" = $1)`, id])
    expect(await purgeTelematicsPositions()).toMatchObject({ ok: true, failed: 0 })
    expect(await database().telematicsPosition.count({ where: { id } })).toBe(0)
  }, 900_000)

  it("the SQL gate for THEFT also refuses a report of ANOTHER loan of the same tenant", async () => {
    const a = await lease(5, "SIM-STEADY-14")
    const b = await lease(5, "SIM-STEADY-15")
    const report = await reportConfirmed(a.loanId, { sapsCaseNumber: caseNo(1107), reportedOn: daysAgo(1) })
    const reportId = (report as { reportId: string }).reportId
    await ruleRefuses(database(), { fn: "telematicsPurposeHolds", replace: ["AND t.\"loanId\" = loan_id", ""] }, /for a purpose the loan has now/, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "TelematicsPositionAccess" ("id", "tenantId", "userId", "loanId", "assetId", "deviceId", "context", "view", "theftReportId")
       VALUES ($1, $2, $3, $4, $5, $6, 'THEFT', 'LATEST', $7)`, `pa_${randomUUID()}`, fx.tenantId, collectorId, b.loanId, b.assetId, b.deviceId, reportId))
  }, 900_000)
})
