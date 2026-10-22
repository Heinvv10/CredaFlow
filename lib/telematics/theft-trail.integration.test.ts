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
import { attempt, ruleRefuses, testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { purgeTelematicsPositions } from "./purge"
import { revealPosition } from "./position-view"
import { revealPositionTrail, THEFT_LOOKBACK_DAYS, TRAIL_LIMIT } from "./position-trail"
import { confirmTheftReport, endTheftReport, recordTheftReport, REPORT_MAX_AGE_DAYS } from "./theft-reports"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient, today } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loan: "", device: "", collector: "", collector2: "", readonly: "", insurance: "", report: "" }
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
    ids.collector2 = await user("collector2", "COLLECTIONS_OFFICER")
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

  it("refuses a malformed case number, a future date, a date over 14 days back, a case of a later year, and READONLY or INSURANCE_OFFICER", async () => {
    const record = (body: Record<string, unknown>, who = collector()) => recordTheftReport(who, ids.loan, body)
    expect(await record({ sapsCaseNumber: "12345", reportedOn: today() })).toMatchObject({ kind: "refused", status: 400, fields: { sapsCaseNumber: expect.any(String) } })
    expect(await record({ sapsCaseNumber: "CAS 12/13/2026", reportedOn: today() })).toMatchObject({ kind: "refused", status: 400 })
    const tomorrow = new Date(Date.parse(`${today()}T00:00:00Z`) + DAY).toISOString().slice(0, 10)
    expect(await record({ sapsCaseNumber: caseNo, reportedOn: tomorrow })).toMatchObject({ kind: "refused", status: 400, fields: { reportedOn: expect.any(String) } })
    expect(await record({ sapsCaseNumber: `CAS 7/1/${Number(today().slice(0, 4)) + 1}`, reportedOn: today() })).toMatchObject({ kind: "refused", status: 400 })
    // Backdated past REPORT_MAX_AGE_DAYS: the trail's week before the report cannot be stretched back.
    expect(await record({ sapsCaseNumber: caseNo, reportedOn: daysAgo(REPORT_MAX_AGE_DAYS + 1) })).toMatchObject({ kind: "refused", status: 400, fields: { reportedOn: expect.stringContaining("14 days") } })
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
    // The form is checked twice: the trigger first (so the year can be read), then the CHECK.
    const FORM = ["IF NEW.\"sapsCaseNumber\" !~ '^CAS [1-9][0-9]{0,5}/(0?[1-9]|1[0-2])/[0-9]{4}$' OR", "IF FALSE AND NEW.\"sapsCaseNumber\" !~ '^CAS [1-9][0-9]{0,5}/(0?[1-9]|1[0-2])/[0-9]{4}$' OR"] as const
    // A case number the year of which is not a number: the trigger names the form (without its check the cast fails, 22P02).
    expect(await attempt(database(), insert({ sapsCaseNumber: "CAS 1/1/20x6" }))).toMatch(/reads CAS/)
    expect(await attempt(database(), insert({ sapsCaseNumber: "CAS 1/1/20x6" }), { fn: "guardAssetTheftReport", replace: FORM })).toMatch(/22P02|invalid input syntax/)
    await expect(database().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "AssetTheftReport" DISABLE TRIGGER "AssetTheftReport_guard"`)
      await insert({ sapsCaseNumber: "cas 1/1/2026" })(tx)
    })).rejects.toThrow(/AssetTheftReport_case_number/)
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["OR split_part(NEW.\"sapsCaseNumber\", '/', 3)::int < 2000 THEN", "THEN"] }, /reads CAS/,
      insert({ sapsCaseNumber: "CAS 1/1/1999" }))
    const future = new Date(Date.parse(`${today()}T00:00:00Z`) + DAY)
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["IF NEW.\"reportedOn\" > today OR", "IF FALSE OR"] }, /no later than today/, insert({ reportedOn: future }))
    // Before the loan started (within 14 days: the loan moved to 5 days ago in the attack, the theft dated 6 days ago).
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["OR NEW.\"reportedOn\" < loan_row.\"startedOn\"", ""] }, /no later than today/, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`UPDATE "Loan" SET "startDate" = now() - INTERVAL '5 days' WHERE "id" = $1`, ids.loan)
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`)
      return insert({ reportedOn: new Date(`${daysAgo(6)}T00:00:00Z`) })(tx)
    })
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["OR split_part(NEW.\"sapsCaseNumber\", '/', 3)::int > extract(year FROM today)::int THEN", "THEN"] },
      /no later than today/, insert({ sapsCaseNumber: `CAS 7/1/${Number(today().slice(0, 4)) + 1}` }))
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["ELSIF NEW.\"reportedOn\" < today - 14 THEN", "ELSIF FALSE THEN"] }, /within 14 days/,
      insert({ reportedOn: new Date(Date.parse(`${daysAgo(REPORT_MAX_AGE_DAYS + 1)}T00:00:00Z`)) }))
    // Recorded, or confirmed, by someone who may not see a position (by SQL, past the TypeScript): refused.
    const STAFF = /by staff who may see a position/
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["IF NOT EXISTS (SELECT 1 FROM \"User\" u WHERE u.\"id\" = NEW.\"recordedById\"", "IF FALSE AND NOT EXISTS (SELECT 1 FROM \"User\" u WHERE u.\"id\" = NEW.\"recordedById\""] },
      STAFF, insert({ recordedById: ids.readonly }))
    // Recorded confirmed (or ended) at once: refused, a second person confirms.
    await ruleRefuses(database(), { table: "AssetTheftReport", trigger: "AssetTheftReport_guard" }, /recorded unconfirmed/, insert({ confirmedById: ids.collector2, confirmedAt: new Date() }))
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
    const reportedOn = (await database().assetTheftReport.findUniqueOrThrow({ where: { id: ids.report } })).reportedOn
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["OR renewed.\"sapsCaseNumber\" IS DISTINCT FROM NEW.\"sapsCaseNumber\"", ""] }, /same loan and case/,
      insert({ sapsCaseNumber: `CAS 9/1/${today().slice(0, 4)}`, renewsReportId: ids.report, reportedOn }))
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["OR renewed.\"reportedOn\" IS DISTINCT FROM NEW.\"reportedOn\"", ""] }, /keeps its date/,
      insert({ renewsReportId: ids.report, reportedOn: new Date(`${today()}T00:00:00Z`) }))
    const CHANGE = /confirmed once and ended once/
    await ruleRefuses(database(), { table: "AssetTheftReport", trigger: "AssetTheftReport_guard" }, CHANGE,
      (tx) => tx.assetTheftReport.update({ where: { id: ids.report }, data: { validUntil: new Date("2099-01-01T00:00:00Z") } }))
    await ruleRefuses(database(), { table: "AssetTheftReport", trigger: "AssetTheftReport_guard" }, /never deleted/,
      (tx) => tx.assetTheftReport.delete({ where: { id: ids.report } }))
    // Confirmed by the one who recorded it: the CHECK refuses (the TypeScript too, below).
    await ruleRefuses(database(), { table: "AssetTheftReport", constraint: "AssetTheftReport_confirmation" }, /AssetTheftReport_confirmation/,
      (tx) => tx.assetTheftReport.update({ where: { id: ids.report }, data: { confirmedById: ids.collector, confirmedAt: new Date() } }))
  }, 120_000)

  it("holds THEFT only once a second person confirms the report", async () => {
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    expect(await confirmTheftReport(collector(), ids.loan, ids.report)).toMatchObject({ kind: "refused", status: 409, error: expect.stringContaining("second person") })
    expect(await confirmTheftReport(as(ids.readonly, "READONLY"), ids.loan, ids.report)).toMatchObject({ kind: "refused", status: 403 })
    expect(await confirmTheftReport(as(ids.collector2, "COLLECTIONS_OFFICER"), ids.loan, ids.report)).toEqual({ kind: "ok" })
    expect(await confirmTheftReport(as(ids.collector2, "COLLECTIONS_OFFICER"), ids.loan, ids.report)).toMatchObject({ kind: "refused", status: 409 })
    const confirmed = await database().assetTheftReport.findUniqueOrThrow({ where: { id: ids.report } })
    expect(confirmed).toMatchObject({ confirmedById: ids.collector2 })
    await ruleRefuses(database(), { table: "AssetTheftReport", trigger: "AssetTheftReport_guard" }, /confirmed once/,
      (tx) => tx.assetTheftReport.update({ where: { id: ids.report }, data: { confirmedById: ids.insurance } }))
    // Confirmed by SQL by someone who may not see a position (the TypeScript refuses READONLY with 403 above): refused.
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["IF (NEW.\"confirmedAt\" IS NOT NULL AND OLD.\"confirmedAt\" IS NULL AND NOT EXISTS", "IF (FALSE AND NOT EXISTS"] },
      /by staff who may see a position/, async (tx) => {
        const fresh = await tx.assetTheftReport.create({ data: { tenantId: fx.tenantId, loanId: ids.loan, assetId: fx.assets[1], sapsCaseNumber: `CAS 77/1/${today().slice(0, 4)}`,
          reportedOn: new Date(`${today()}T00:00:00Z`), validUntil: new Date(`${today()}T00:00:00Z`), recordedById: ids.collector } })
        await tx.assetTheftReport.update({ where: { id: fresh.id }, data: { confirmedById: ids.readonly, confirmedAt: new Date() } })
      })
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "TELEMATICS_THEFT_REPORT_CONFIRMED", userId: ids.collector2 } })).toBe(1)
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

  it("holds each purpose exactly as the database defines it (telematicsPurposeHolds), branch by branch", async () => {
    const holds = async (context: string, reportId: string | null = null, loanId = ids.loan) =>
      (await database().$queryRawUnsafe<{ h: boolean }[]>(`SELECT "telematicsPurposeHolds"($1, $2, $3::"TelematicsPositionContext", $4) AS h`, fx.tenantId, loanId, context, reportId))[0].h
    // DEFAULT: in default or pending write-off; not running in good standing, not written off.
    const statuses: [string, boolean][] = [["ACTIVE", false], ["DEFAULTED", true], ["PENDING_WRITE_OFF", true], ["WRITTEN_OFF", false]]
    for (const [status, expected] of statuses) {
      await loanStatus(status)
      expect([status, await holds("DEFAULT")]).toEqual([status, expected])
    }
    await loanStatus("ACTIVE")
    // RECOVERY: a recovery that is not CLOSED or WITHDRAWN.
    await testSetup(database(), [`INSERT INTO "Recovery" ("id", "tenantId", "loanId", "assetId", "route", "status", "recoveredOn", "location", "condition", "createdById", "updatedAt")
      VALUES ($1, $2, $3, $4, 'NON_NCA_COURT_ORDER', 'RECOVERED', CURRENT_DATE, 'Synthetic yard', 'Synthetic condition', $5, now())`, `rcp_${t}`, fx.tenantId, ids.loan, fx.assets[1], fx.adminA])
    expect(await holds("RECOVERY")).toBe(true)
    for (const status of ["CLOSED", "WITHDRAWN"]) {
      await testSetup(database(), [`UPDATE "Recovery" SET "status" = $2::"RecoveryStatus", "closedAt" = now(),
        "withdrawnReason" = CASE WHEN $2 = 'WITHDRAWN' THEN 'Synthetic withdrawal' END WHERE "id" = $1`, `rcp_${t}`, status])
      expect([status, await holds("RECOVERY")]).toEqual([status, false])
    }
    // LEGAL_MATTER: an OPEN matter only.
    await testSetup(database(), [`INSERT INTO "LegalMatter" ("id", "tenantId", "loanId", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, now())`, `lmp_${t}`, fx.tenantId, ids.loan, fx.adminA])
    expect(await holds("LEGAL_MATTER")).toBe(true)
    await testSetup(database(), [`UPDATE "LegalMatter" SET "status" = 'CLOSED', "closedAt" = now() WHERE "id" = $1`, `lmp_${t}`])
    expect(await holds("LEGAL_MATTER")).toBe(false)
    // THEFT: this loan's confirmed, open, valid report on a running loan; nothing else.
    expect(await holds("THEFT", ids.report)).toBe(true)
    expect(await holds("THEFT", null)).toBe(false)
    expect(await holds("THEFT", ids.report, `${ids.loan}_other`)).toBe(false)
    await loanStatus("COMPLETED")
    expect(await holds("THEFT", ids.report)).toBe(false)
    await loanStatus("ACTIVE")
    await testSetup(database(), [`UPDATE "AssetTheftReport" SET "confirmedById" = NULL, "confirmedAt" = NULL WHERE "id" = $1`, ids.report])
    expect(await holds("THEFT", ids.report)).toBe(false)
    await testSetup(database(), [`UPDATE "AssetTheftReport" SET "confirmedById" = $2, "confirmedAt" = now(), "endedById" = $2, "endedAt" = now(), "endReason" = 'Synthetic: the asset was found' WHERE "id" = $1`, ids.report, ids.collector2])
    expect(await holds("THEFT", ids.report)).toBe(false)
    await testSetup(database(), [`UPDATE "AssetTheftReport" SET "endedById" = NULL, "endedAt" = NULL, "endReason" = NULL WHERE "id" = $1`, ids.report])
    expect(await holds("THEFT", ids.report)).toBe(true)
    // The recovery and the matter go again (a recovery ends the tenure on its date; the trail tests below need the whole of it).
    await testSetup(database(), [`DELETE FROM "Recovery" WHERE "id" = $1`, `rcp_${t}`], [`DELETE FROM "LegalMatter" WHERE "id" = $1`, `lmp_${t}`])
    // A latest-position row carries no count; a trail row always does.
    await ruleRefuses(database(), { fn: "guardTelematicsPositionAccess", replace: ["IF NEW.\"view\" = 'LATEST' AND NEW.\"positionCount\" IS NOT NULL THEN", "IF FALSE THEN"] },
      /latest-position access has no point count/, insertAccess("THEFT", "LATEST", ids.report, 3))
    await ruleRefuses(database(), { fn: "guardTelematicsPositionAccess", replace: ["OR NEW.\"positionCount\" IS NULL", ""] },
      /trail is shown for theft, recovery or a legal matter/, insertAccess("THEFT", "TRAIL", ids.report, null))
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
    // THEFT: from a week before the theft was reported (two days ago), not the whole tenure.
    const reported = await database().assetTheftReport.findUniqueOrThrow({ where: { id: ids.report } })
    const theftFrom = reported.reportedOn.getTime() - THEFT_LOOKBACK_DAYS * DAY
    expect(all.slice(1).some((p) => p.occurredAt.getTime() < theftFrom)).toBe(true)
    const expected = all.slice(1).filter((p) => p.occurredAt.getTime() >= theftFrom).map((p) => p.occurredAt.toISOString())
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
    const t0 = Date.now()
    const kept = ((await revealPositionTrail(collector(), ids.loan, { context: "THEFT" }, meta)) as { points: { occurredAt: string }[] }).points.map((p) => p.occurredAt)
    const t1 = Date.now()
    // Every fix younger than a day at the end of the call is shown; none older than a day at its start.
    const surely = all.slice(1).filter((p) => p.occurredAt.getTime() >= t1 - DAY).map((p) => p.occurredAt.toISOString())
    const maybe = all.slice(1).filter((p) => p.occurredAt.getTime() >= t0 - DAY).map((p) => p.occurredAt.toISOString())
    expect(kept.length).toBeLessThan(expected.length)
    expect(kept).toEqual(expect.arrayContaining(surely))
    expect(maybe).toEqual(expect.arrayContaining(kept))
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
    // A legal matter's trail is the whole tenure: every fix from the loan's start (not the one moved before it).
    const legal = await revealPositionTrail(collector(), ids.loan, { context: "LEGAL_MATTER" }, meta)
    const loan = await database().loan.findUniqueOrThrow({ where: { id: ids.loan } })
    const inTenure = (await database().telematicsPosition.findMany({ where: { deviceId: ids.device }, orderBy: { occurredAt: "asc" } }))
    expect(inTenure.some((p) => p.occurredAt < loan.startDate)).toBe(true)
    expect((legal as { points: { occurredAt: string }[] }).points.map((p) => p.occurredAt))
      .toEqual(inTenure.filter((p) => p.occurredAt >= loan.startDate).map((p) => p.occurredAt.toISOString()))
    expect((await accessRows()).at(-1)).toMatchObject({ view: "TRAIL", context: "LEGAL_MATTER", theftReportId: null })
    await loanStatus("ACTIVE")
  }, 120_000)

  it("ends a trail at the next agreement on the asset: a fix after the next loan's start is not this loan's", async () => {
    // The matter from the test above is open; a later running loan on the asset began yesterday at 10:00 SAST (test setup).
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10)
    await testSetup(database(),
      [`INSERT INTO "LoanApplication" SELECT (jsonb_populate_record(NULL::"LoanApplication", to_jsonb(a) || jsonb_build_object('id', $2::text, 'reference', $2::text))).*
        FROM "LoanApplication" a WHERE a."id" = (SELECT "applicationId" FROM "Loan" WHERE "id" = $1)`, ids.loan, `trnapp_${t}`],
      [`INSERT INTO "Loan" SELECT (jsonb_populate_record(NULL::"Loan", to_jsonb(l) || jsonb_build_object('id', $2::text, 'reference', $2::text, 'applicationId', $3::text,
          'status', 'ACTIVE', 'startDate', $4::timestamp))).* FROM "Loan" l WHERE l."id" = $1`, ids.loan, `trn_${t}`, `trnapp_${t}`, `${yesterday} 08:00:00`])
    try {
      const points = ((await revealPositionTrail(collector(), ids.loan, { context: "LEGAL_MATTER" }, meta)) as { points: { occurredAt: string }[] }).points
      const cut = new Date(`${yesterday}T00:00:00+02:00`).getTime()
      const afterCut = await database().telematicsPosition.count({ where: { deviceId: ids.device, occurredAt: { gte: new Date(cut) } } })
      expect(afterCut).toBeGreaterThan(0)
      expect(points.length).toBeGreaterThan(0)
      expect(points.every((p) => Date.parse(p.occurredAt) < cut)).toBe(true)
    } finally {
      await testSetup(database(), [`DELETE FROM "Loan" WHERE "id" = $1`, `trn_${t}`], [`DELETE FROM "LoanApplication" WHERE "id" = $1`, `trnapp_${t}`])
    }
  }, 120_000)

  it("ends a theft report early, once, with a reason: THEFT stops holding at once", async () => {
    expect(await endTheftReport(collector(), ids.loan, ids.report, { reason: "short" })).toMatchObject({ kind: "refused", status: 400 })
    expect(await endTheftReport(as(ids.readonly, "READONLY"), ids.loan, ids.report, { reason: "The excavator was found at a synthetic yard" })).toMatchObject({ kind: "refused", status: 403 })
    expect(await endTheftReport(collector(), ids.loan, ids.report, { reason: "The excavator was found at a synthetic yard" })).toEqual({ kind: "ok" })
    expect(await endTheftReport(collector(), ids.loan, ids.report, { reason: "The excavator was found at a synthetic yard" })).toMatchObject({ kind: "refused", status: 404 })
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    await ruleRefuses(database(), { table: "AssetTheftReport", trigger: "AssetTheftReport_guard" }, /ended once/,
      (tx) => tx.assetTheftReport.update({ where: { id: ids.report }, data: { endReason: "Another synthetic reason" } }))
    await ruleRefuses(database(), { table: "AssetTheftReport", constraint: "AssetTheftReport_confirmation" }, /AssetTheftReport_confirmation/,
      (tx) => tx.$executeRawUnsafe(`ALTER TABLE "AssetTheftReport" DISABLE TRIGGER "AssetTheftReport_guard"`).then(() =>
        tx.assetTheftReport.update({ where: { id: ids.report }, data: { endReason: "short" } })))
    // A renewal of the same case keeps the original's date and needs its own confirmation.
    const renewed = await recordTheftReport(collector(), ids.loan, { sapsCaseNumber: caseNo, reportedOn: today(), renewsReportId: ids.report })
    expect(renewed).toMatchObject({ kind: "ok" })
    const row = await database().assetTheftReport.findUniqueOrThrow({ where: { id: (renewed as { reportId: string }).reportId } })
    const original = await database().assetTheftReport.findUniqueOrThrow({ where: { id: ids.report } })
    expect(row.reportedOn).toEqual(original.reportedOn)
    expect(row.confirmedAt).toBeNull()
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    expect(await confirmTheftReport(as(ids.collector2, "COLLECTIONS_OFFICER"), ids.loan, row.id)).toEqual({ kind: "ok" })
    expect(await revealPosition(collector(), ids.loan, { context: "THEFT" }, meta)).toMatchObject({ kind: "ok" })
    // A case is renewed at most twice (three reports, 90 days): then a recovery or a legal matter.
    const second = await recordTheftReport(collector(), ids.loan, { sapsCaseNumber: caseNo, reportedOn: today(), renewsReportId: row.id })
    expect(second).toMatchObject({ kind: "ok" })
    expect(await recordTheftReport(collector(), ids.loan, { sapsCaseNumber: caseNo, reportedOn: today(), renewsReportId: (second as { reportId: string }).reportId }))
      .toMatchObject({ kind: "refused", status: 409, error: expect.stringContaining("at most twice") })
    await ruleRefuses(database(), { fn: "guardAssetTheftReport", replace: ["AND r.\"sapsCaseNumber\" = NEW.\"sapsCaseNumber\") >= 3 THEN", "AND r.\"sapsCaseNumber\" = NEW.\"sapsCaseNumber\") >= 99 THEN"] },
      /renewed at most twice/, (tx) => tx.assetTheftReport.create({ data: { tenantId: fx.tenantId, loanId: ids.loan, assetId: fx.assets[1], sapsCaseNumber: caseNo,
        reportedOn: original.reportedOn, validUntil: original.reportedOn, renewsReportId: (second as { reportId: string }).reportId, recordedById: ids.collector } }))
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
