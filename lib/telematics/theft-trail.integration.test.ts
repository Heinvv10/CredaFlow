/**
 * THEFT, the SQL purpose gate and the position trail on real Postgres
 * (docs/asset-finance/SLICE5-FOLLOWUPS.md part T): a THEFT reveal needs a
 * SAPS report valid today (30 days from its recording) on a running loan;
 * the report's case number, dates and loan are the database's to check; an
 * access row is refused by the database when its purpose does not hold, and
 * a TRAIL row for DEFAULT; the trail is THEFT, RECOVERY or LEGAL_MATTER only,
 * inside the tenure and retention, oldest first, each view logged with its
 * count and audited without a coordinate; READONLY, INSURANCE_OFFICER and a
 * dealer are refused (403, audited); the purge removes old positions one by
 * one and keeps the rest.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/theft-trail.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleRefuses, testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { purgeTelematicsPositions } from "./purge"
import { revealPosition } from "./position-view"
import { revealPositionTrail, TRAIL_LIMIT } from "./position-trail"
import { recordTheftReport } from "./theft-reports"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient, today } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loan: "", device: "", collector: "", readonly: "", insurance: "", report: "" }
const meta = { ipAddress: "192.0.2.11", userAgent: "telematics-theft-it" }
const DAY = 86_400_000

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const as = (userId: string, role: string) => ({ tenantId: fx.tenantId, userId, userEmail: `${userId}@telematics-it.test`, role })
const collector = () => as(ids.collector, "COLLECTIONS_OFFICER")
const user = async (label: string, role: "COLLECTIONS_OFFICER" | "READONLY" | "INSURANCE_OFFICER") =>
  (await database().user.create({ data: { tenantId: fx.tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role } })).id
const accessRows = () => database().telematicsPositionAccess.findMany({ where: { tenantId: fx.tenantId, loanId: ids.loan }, orderBy: { createdAt: "asc" } })
const caseNo = `CAS 4${t.replace(/\D/g, "").slice(0, 3) || "12"}/${Number(today().slice(5, 7))}/${today().slice(0, 4)}`
const loanStatus = (status: string) => testSetup(database(), [`UPDATE "Loan" SET "status" = $2::"LoanStatus" WHERE "id" = $1`, ids.loan, status])
/** An access row written by hand (SQL), as a path that skipped the TypeScript gate would. */
const insertAccess = (context: string, view: "LATEST" | "TRAIL", theftReportId: string | null, positionCount: number | null) =>
  (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => tx.$executeRawUnsafe(
    `INSERT INTO "TelematicsPositionAccess" ("id", "tenantId", "userId", "loanId", "assetId", "deviceId", "context", "view", "theftReportId", "positionCount")
     VALUES ($1, $2, $3, $4, $5, $6, $7::"TelematicsPositionContext", $8::"TelematicsPositionView", $9, $10)`,
    `pa_${randomUUID()}`, fx.tenantId, ids.collector, ids.loan, fx.assets[1], ids.device, context, view, theftReportId, positionCount)

suite.sequential("telematics THEFT purpose, SQL purpose gate and position trail (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.loan = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    ids.device = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    ids.collector = await user("collector", "COLLECTIONS_OFFICER")
    ids.readonly = await user("readonly", "READONLY")
    ids.insurance = await user("insurance", "INSURANCE_OFFICER")
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("refuses THEFT with no report (409, audited, no view logged)", async () => {
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta))
      .toMatchObject({ kind: "refused", status: 409, error: "Position is shown only for a loan in default, legal action, recovery or a reported theft" })
    await loanStatus("DEFAULTED")
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409, error: "This loan has no theft report valid today" })
    expect(await revealPositionTrail(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    await loanStatus("ACTIVE")
    expect(await accessRows()).toHaveLength(0)
  }, 120_000)

  it("refuses a malformed case number, a future date, a case of a later year, and READONLY or INSURANCE_OFFICER", async () => {
    const record = (body: Record<string, unknown>, who = collector()) => recordTheftReport(who, ids.loan, body)
    expect(await record({ sapsCaseNumber: "12345", reportedOn: today() })).toMatchObject({ kind: "refused", status: 400, fields: { sapsCaseNumber: expect.any(String) } })
    expect(await record({ sapsCaseNumber: "CAS 12/13/2026", reportedOn: today() })).toMatchObject({ kind: "refused", status: 400 })
    const tomorrow = new Date(Date.parse(`${today()}T00:00:00Z`) + DAY).toISOString().slice(0, 10)
    expect(await record({ sapsCaseNumber: caseNo, reportedOn: tomorrow })).toMatchObject({ kind: "refused", status: 400, fields: { reportedOn: expect.any(String) } })
    expect(await record({ sapsCaseNumber: `CAS 7/1/${Number(today().slice(0, 4)) + 1}`, reportedOn: today() })).toMatchObject({ kind: "refused", status: 400 })
    expect(await record({ sapsCaseNumber: caseNo, reportedOn: today() }, as(ids.readonly, "READONLY"))).toMatchObject({ kind: "refused", status: 403 })
    expect(await record({ sapsCaseNumber: caseNo, reportedOn: today() }, as(ids.insurance, "INSURANCE_OFFICER"))).toMatchObject({ kind: "refused", status: 403 })
    expect(await record({ sapsCaseNumber: caseNo, reportedOn: today() }, as(ids.collector, "DEALER"))).toMatchObject({ kind: "refused", status: 403 })
    expect(await database().assetTheftReport.count({ where: { tenantId: fx.tenantId } })).toBe(0)
  }, 120_000)

  it("holds the report's rules in the database: case number form, dates, a running loan, a renewal of the same case, never changed", async () => {
    const insert = (over: Record<string, unknown>) => (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => tx.assetTheftReport.create({ data: {
      tenantId: fx.tenantId, loanId: ids.loan, assetId: fx.assets[1], sapsCaseNumber: caseNo, reportedOn: new Date(`${today()}T00:00:00Z`),
      validUntil: new Date(`${today()}T00:00:00Z`), recordedById: ids.collector, ...over,
    } })
    await ruleRefuses(database(), { table: "AssetTheftReport", constraint: "AssetTheftReport_case_number" }, /AssetTheftReport_case_number/, insert({ sapsCaseNumber: "cas 1/1/2026" }))
    const future = new Date(Date.parse(`${today()}T00:00:00Z`) + DAY)
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["IF NEW.\"reportedOn\" > today OR", "IF FALSE AND"] }, /no later than today/, insert({ reportedOn: future }))
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["NOT IN ('ACTIVE', 'DEFAULTED', 'PENDING_WRITE_OFF')", "IS NULL"] }, /running loan/,
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, ids.loan)
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`)
        return insert({})(tx)
      })
    // Recorded through the module: the database sets validUntil to today + 30, whatever was sent.
    const recorded = await recordTheftReport(collector(), ids.loan, { sapsCaseNumber: caseNo.toLowerCase().replace(" ", ""), reportedOn: daysAgo(2) })
    const in30 = new Date(Date.parse(`${today()}T00:00:00Z`) + 30 * DAY).toISOString().slice(0, 10)
    expect(recorded).toMatchObject({ kind: "ok", validUntil: in30 })
    ids.report = (recorded as { reportId: string }).reportId
    expect(await database().assetTheftReport.findUniqueOrThrow({ where: { id: ids.report } })).toMatchObject({ sapsCaseNumber: caseNo })
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["AND r.\"sapsCaseNumber\" = NEW.\"sapsCaseNumber\") THEN", ") THEN"] }, /same loan and case/,
      insert({ sapsCaseNumber: `CAS 9/1/${today().slice(0, 4)}`, renewsReportId: ids.report }))
    await ruleRefuses(database(), { table: "AssetTheftReport", trigger: "AssetTheftReport_guard" }, /never changed or deleted/,
      (tx) => tx.assetTheftReport.update({ where: { id: ids.report }, data: { validUntil: new Date("2099-01-01T00:00:00Z") } }))
    await ruleRefuses(database(), { table: "AssetTheftReport", trigger: "AssetTheftReport_guard" }, /never changed or deleted/,
      (tx) => tx.assetTheftReport.delete({ where: { id: ids.report } }))
  }, 120_000)

  it("shows THEFT with a valid report and logs the report on the access row; refuses it on day 31 and on a closed loan", async () => {
    const shown = await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)
    expect(shown).toMatchObject({ kind: "ok", position: { simulated: true } })
    const [row] = await accessRows()
    expect(row).toMatchObject({ context: "THEFT", view: "LATEST", theftReportId: ids.report, positionCount: null, userId: ids.collector })
    // Day 30 still holds; day 31 does not (validUntil moved back, triggers off: test setup).
    await testSetup(database(), [`UPDATE "AssetTheftReport" SET "validUntil" = $2::date WHERE "id" = $1`, ids.report, today()])
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "ok" })
    await testSetup(database(), [`UPDATE "AssetTheftReport" SET "validUntil" = $2::date WHERE "id" = $1`, ids.report, daysAgo(1)])
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    expect(await revealPositionTrail(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    await testSetup(database(), [`UPDATE "AssetTheftReport" SET "validUntil" = $2::date WHERE "id" = $1`, ids.report, today()])
    await loanStatus("COMPLETED")
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    await loanStatus("ACTIVE")
    expect(await accessRows()).toHaveLength(2)
  }, 120_000)

  it("refuses at the database an access row whose purpose does not hold, a TRAIL for DEFAULT, and a THEFT row without its report", async () => {
    const purposeClause = ["IF NOT \"telematicsPurposeHolds\"(NEW.\"tenantId\", NEW.\"loanId\", NEW.\"context\", NEW.\"theftReportId\") THEN", "IF FALSE THEN"] as const
    const gate = { fn: "guardTelematicsPositionAccess", replace: purposeClause }
    // The loan is ACTIVE with no recovery or matter: DEFAULT, RECOVERY and LEGAL_MATTER do not hold.
    for (const context of ["DEFAULT", "RECOVERY", "LEGAL_MATTER"]) {
      await ruleRefuses(database(), gate, /for a purpose the loan has now/, insertAccess(context, "LATEST", null, null))
    }
    await testSetup(database(), [`UPDATE "AssetTheftReport" SET "validUntil" = $2::date WHERE "id" = $1`, ids.report, daysAgo(1)])
    await ruleRefuses(database(), gate, /for a purpose the loan has now/, insertAccess("THEFT", "LATEST", ids.report, null))
    await testSetup(database(), [`UPDATE "AssetTheftReport" SET "validUntil" = $2::date WHERE "id" = $1`, ids.report, today()])
    // DEFAULT holds (the loan defaulted): a DEFAULT row naming a theft report is refused, and a trail for DEFAULT.
    await loanStatus("DEFAULTED")
    await ruleRefuses(database(), { fn: "guardTelematicsPositionAccess", replace: ["IF (NEW.\"context\" = 'THEFT') <> (NEW.\"theftReportId\" IS NOT NULL) THEN", "IF FALSE THEN"] },
      /names its theft report/, insertAccess("DEFAULT", "LATEST", ids.report, null))
    await ruleRefuses(database(), { fn: "guardTelematicsPositionAccess", replace: ["IF NEW.\"view\" = 'TRAIL' AND (NEW.\"context\" = 'DEFAULT' OR", "IF NEW.\"view\" = 'TRAIL' AND (FALSE OR"] },
      /trail is shown for theft, recovery or a legal matter/, insertAccess("DEFAULT", "TRAIL", null, 3))
    await loanStatus("ACTIVE")
  }, 120_000)

  it("shows the trail for THEFT only inside the tenure and retention, oldest first, logged with its count and audited without a coordinate", async () => {
    const loan = await database().loan.findUniqueOrThrow({ where: { id: ids.loan } })
    const all = await database().telematicsPosition.findMany({ where: { deviceId: ids.device }, orderBy: { occurredAt: "asc" } })
    expect(all.length).toBeGreaterThan(2)
    // One fix moved before the loan started: not this loan's.
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = $2 WHERE "id" = $1`, all[0].id, new Date(loan.startDate.getTime() - DAY)])
    const before = await accessRows()
    const trail = await revealPositionTrail(collector(), ids.loan, { context: "THEFT" }, meta)
    expect(trail).toMatchObject({ kind: "ok", truncated: false })
    const points = (trail as { points: { occurredAt: string; latitude: number }[] }).points
    const expected = all.slice(1).map((p) => p.occurredAt.toISOString())
    expect(points.map((p) => p.occurredAt)).toEqual(expected)
    expect(points.length).toBeLessThanOrEqual(TRAIL_LIMIT)
    const rows = await accessRows()
    expect(rows).toHaveLength(before.length + 1)
    expect(rows.at(-1)).toMatchObject({ view: "TRAIL", context: "THEFT", theftReportId: ids.report, positionCount: expected.length, positionId: null, ipAddress: meta.ipAddress })
    const audit = await database().auditLog.findFirstOrThrow({ where: { tenantId: fx.tenantId, action: "TELEMATICS_POSITION_TRAIL_VIEWED" }, orderBy: { createdAt: "desc" } })
    expect(audit).toMatchObject({ userId: ids.collector, entityId: ids.loan, newValue: { context: "THEFT", accessId: rows.at(-1)?.id, points: expected.length } })
    expect(JSON.stringify(audit)).not.toMatch(/latitude|longitude|-3\d\.\d{4}/)
    // Retention 1 day: older fixes drop out of the trail before any purge runs.
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 1 } })
    const recent = all.slice(1).filter((p) => p.occurredAt.getTime() >= Date.now() - DAY + 60_000)
    const kept = await revealPositionTrail(collector(), ids.loan, { context: "THEFT" }, meta)
    expect((kept as { points: unknown[] }).points).toHaveLength(recent.length)
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 90 } })
  }, 120_000)

  it("refuses the trail for DEFAULT (400) and for READONLY, INSURANCE_OFFICER and a dealer (403, audited, nothing logged)", async () => {
    await loanStatus("DEFAULTED")
    const before = (await accessRows()).length
    expect(await revealPositionTrail(collector(), ids.loan, { context: "DEFAULT" }, meta)).toMatchObject({ kind: "refused", status: 400 })
    for (const [who, role] of [[ids.readonly, "READONLY"], [ids.insurance, "INSURANCE_OFFICER"], [ids.collector, "DEALER"]] as const) {
      expect(await revealPositionTrail(as(who, role), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 403 })
    }
    expect(await accessRows()).toHaveLength(before)
    const refusals = await database().auditLog.findMany({ where: { tenantId: fx.tenantId, action: "TELEMATICS_POSITION_REFUSED", entityId: ids.loan } })
    expect(refusals.filter((r) => (r.newValue as { view?: string }).view === "TRAIL" && (r.newValue as { httpStatus: number }).httpStatus === 403)).toHaveLength(3)
    // RECOVERY and LEGAL_MATTER give a trail too.
    await testSetup(database(), [`INSERT INTO "LegalMatter" ("id", "tenantId", "loanId", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, now())`, `lm_${t}`, fx.tenantId, ids.loan, fx.adminA])
    expect(await revealPositionTrail(collector(), ids.loan, { context: "LEGAL_MATTER" }, meta)).toMatchObject({ kind: "ok" })
    expect((await accessRows()).at(-1)).toMatchObject({ view: "TRAIL", context: "LEGAL_MATTER", theftReportId: null })
    await loanStatus("ACTIVE")
  }, 120_000)

  it("purges positions one by one past retention and keeps the younger ones of the same device", async () => {
    const all = await database().telematicsPosition.findMany({ where: { deviceId: ids.device }, orderBy: { occurredAt: "asc" } })
    const old = all.slice(0, Math.ceil(all.length / 2))
    // Move the older half past retention (90 days), as positions written then would be.
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = "occurredAt" - INTERVAL '120 days' WHERE "id" = ANY($1::text[])`, old.map((p) => p.id)],
      [`UPDATE "TelematicsEvent" SET "occurredAt" = "occurredAt" - INTERVAL '120 days', "receivedAt" = "receivedAt" - INTERVAL '120 days' WHERE "id" = ANY($1::text[])`, old.map((p) => p.eventId)])
    expect(await purgeTelematicsPositions()).toMatchObject({ ok: true })
    const left = await database().telematicsPosition.findMany({ where: { deviceId: ids.device }, select: { id: true } })
    expect(left.map((p) => p.id).sort()).toEqual(all.slice(old.length).map((p) => p.id).sort())
  }, 120_000)
})
