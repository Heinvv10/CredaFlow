/**
 * The last known position on real Postgres (docs/asset-finance/SLICE5.md part
 * B, POPIA): revealed only to collections staff and above (never READONLY or
 * INSURANCE_OFFICER), only for the purpose the loan has now (default, an open
 * recovery, an open legal matter), only from this loan's tenure of the asset
 * and within retention; every reveal, a "none" included, writes an access row
 * first, every 403 or 409 is audited, and the log is append-only.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/position-view.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleRefuses, testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { revealPosition } from "./position-view"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loan: "", device: "", collector: "", readonly: "", insurance: "", oldLoan: "" }
const meta = { ipAddress: "192.0.2.10", userAgent: "telematics-it" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const as = (userId: string, role: string) => ({ tenantId: fx.tenantId, userId, userEmail: `${userId}@telematics-it.test`, role })
const accessRows = (loanId = ids.loan) => database().telematicsPositionAccess.count({ where: { tenantId: fx.tenantId, loanId } })
const refusalsOf = (loanId: string) => database().auditLog.findMany({ where: { tenantId: fx.tenantId, action: "TELEMATICS_POSITION_REFUSED", entityId: loanId }, orderBy: { createdAt: "asc" } })
const user = async (label: string, role: "COLLECTIONS_OFFICER" | "READONLY" | "INSURANCE_OFFICER") =>
  (await database().user.create({ data: { tenantId: fx.tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role } })).id

suite.sequential("telematics last known position: who, why, when, logged (real DB)", () => {
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

  it("refuses READONLY and INSURANCE_OFFICER with 403, logs no view, and audits the refusal without a coordinate", async () => {
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.loan])
    expect(await revealPosition(as(ids.readonly, "READONLY"), ids.loan, { context: "DEFAULT" }, meta)).toMatchObject({ kind: "refused", status: 403 })
    expect(await revealPosition(as(ids.insurance, "INSURANCE_OFFICER"), ids.loan, { context: "DEFAULT" }, meta)).toMatchObject({ kind: "refused", status: 403 })
    expect(await revealPosition(as(ids.collector, "DEALER"), ids.loan, { context: "DEFAULT" }, meta)).toMatchObject({ kind: "refused", status: 403 })
    expect(await accessRows()).toBe(0)
    const refusals = await refusalsOf(ids.loan)
    expect(refusals.map((r) => [r.userId, (r.newValue as { httpStatus: number }).httpStatus])).toEqual([[ids.readonly, 403], [ids.insurance, 403], [ids.collector, 403]])
    expect(JSON.stringify(refusals)).not.toMatch(/latitude|longitude/)
  }, 120_000)

  it("shows a collections officer the latest position with its time, and logs who, when, which loan, which purpose and which position", async () => {
    const result = await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "DEFAULT" }, meta)
    const latest = await database().telematicsPosition.findFirstOrThrow({ where: { deviceId: ids.device }, orderBy: { occurredAt: "desc" } })
    expect(result).toMatchObject({ kind: "ok", position: {
      latitude: Number(latest.latitude), longitude: Number(latest.longitude), accuracyM: latest.accuracyM, occurredAt: latest.occurredAt.toISOString(), simulated: true,
    } })
    const [row] = await database().telematicsPositionAccess.findMany({ where: { loanId: ids.loan } })
    expect(row).toMatchObject({ userId: ids.collector, context: "DEFAULT", positionId: latest.id, positionOccurredAt: latest.occurredAt, deviceId: ids.device, ipAddress: meta.ipAddress })
    // The audit trail has the view too, in the same transaction as the access row, without a coordinate.
    const viewed = await database().auditLog.findMany({ where: { tenantId: fx.tenantId, action: "TELEMATICS_POSITION_VIEWED" } })
    expect(viewed).toHaveLength(1)
    expect(viewed[0]).toMatchObject({ userId: ids.collector, entityId: ids.loan, newValue: { context: "DEFAULT", accessId: row.id, positionId: latest.id, positionOccurredAt: latest.occurredAt.toISOString() } })
    expect(JSON.stringify(viewed)).not.toMatch(/latitude|longitude|-3\d\.\d{4}/)
  }, 120_000)

  it("answers each purpose only while the loan has it (409, audited, no view logged): default, an open recovery, an open legal matter", async () => {
    const collector = as(ids.collector, "COLLECTIONS_OFFICER")
    // Two days back, so a recovery dated today ends the tenure after it.
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = "occurredAt" - INTERVAL '2 days' WHERE "deviceId" = $1`, ids.device])
    const before = await accessRows()
    const refusedBefore = (await refusalsOf(ids.loan)).length
    expect(await revealPosition(collector, ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "refused", status: 409, error: "This loan has no open recovery" })
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'ACTIVE' WHERE "id" = $1`, ids.loan])
    expect(await revealPosition(collector, ids.loan, { context: "DEFAULT" }, meta))
      .toMatchObject({ kind: "refused", status: 409, error: "Position is shown only for a loan in default, legal action, recovery or a reported theft" })
    await testSetup(database(), [`INSERT INTO "Recovery" ("id", "tenantId", "loanId", "assetId", "route", "status", "recoveredOn", "location", "condition", "createdById", "closedAt", "withdrawnReason", "updatedAt")
      VALUES ($1, $2, $3, $4, 'NON_NCA_COURT_ORDER', 'WITHDRAWN', CURRENT_DATE, 'Synthetic yard', 'Synthetic condition', $5, now(), 'Synthetic withdrawal', now())`, `rc_${t}`, fx.tenantId, ids.loan, fx.assets[1], fx.adminA])
    expect(await revealPosition(collector, ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    expect(await accessRows()).toBe(before)
    expect((await refusalsOf(ids.loan)).length).toBe(refusedBefore + 3)
    const recovery = (status: string) => testSetup(database(), [`UPDATE "Recovery" SET "status" = $2::"RecoveryStatus",
      "closedAt" = CASE WHEN $2 = 'WITHDRAWN' THEN now() END, "withdrawnReason" = CASE WHEN $2 = 'WITHDRAWN' THEN 'Synthetic withdrawal' END WHERE "id" = $1`, `rc_${t}`, status])
    await recovery("RECOVERED")
    expect(await revealPosition(collector, ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "ok", position: { simulated: true } })
    expect(await revealPosition(collector, ids.loan, { context: "DEFAULT" }, meta)).toMatchObject({ kind: "refused", status: 409, error: "This loan is not in default" })
    await recovery("WITHDRAWN")
    await testSetup(database(), [`INSERT INTO "LegalMatter" ("id", "tenantId", "loanId", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, now())`, `lm_${t}`, fx.tenantId, ids.loan, fx.adminA])
    expect(await revealPosition(collector, ids.loan, { context: "LEGAL_MATTER" }, meta)).toMatchObject({ kind: "ok", position: { simulated: true } })
    await testSetup(database(), [`UPDATE "LegalMatter" SET "status" = 'CLOSED', "closedAt" = now() WHERE "id" = $1`, `lm_${t}`],
      [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.loan])
    expect(await revealPosition(collector, ids.loan, { context: "LEGAL_MATTER" }, meta)).toMatchObject({ kind: "refused", status: 409, error: "This loan has no open legal matter" })
    expect(await revealPosition(collector, ids.loan, { context: "SOMETHING" }, meta)).toMatchObject({ kind: "refused", status: 400 })
    expect(await accessRows()).toBe(before + 2)
    expect((await database().telematicsPositionAccess.findMany({ where: { loanId: ids.loan }, orderBy: { createdAt: "desc" }, take: 2 })).map((r) => r.context))
      .toEqual(["LEGAL_MATTER", "RECOVERY"])
  }, 120_000)

  it("never shows a position from outside this loan's tenure or older than retention, and logs a 'none' too", async () => {
    // Re-leased: this loan's start moves to 10 days ago, and an older loan on the asset ends where it began.
    await testSetup(database(),
      [`UPDATE "Loan" SET "startDate" = "startDate" + INTERVAL '20 days' WHERE "id" = $1`, ids.loan],
      // A copy of the loan (and its application) on the same asset, from 20 days before it to its start.
      [`INSERT INTO "LoanApplication" SELECT (jsonb_populate_record(NULL::"LoanApplication", to_jsonb(a) || jsonb_build_object('id', $2::text, 'reference', $2::text))).*
        FROM "LoanApplication" a WHERE a."id" = (SELECT "applicationId" FROM "Loan" WHERE "id" = $1)`, ids.loan, `oldapp_${t}`],
      [`INSERT INTO "Loan" SELECT (jsonb_populate_record(NULL::"Loan", to_jsonb(l) || jsonb_build_object('id', $2::text, 'reference', $2::text, 'applicationId', $3::text,
          'status', 'DEFAULTED', 'startDate', l."startDate" - INTERVAL '20 days', 'maturityDate', l."startDate"))).*
        FROM "Loan" l WHERE l."id" = $1`, ids.loan, `old_${t}`, `oldapp_${t}`])
    ids.oldLoan = `old_${t}`
    const collector = as(ids.collector, "COLLECTIONS_OFFICER")
    const reveal = (loanId: string) => revealPosition(collector, loanId, { context: "DEFAULT" }, meta)
    const startOfNew = (await database().loan.findUniqueOrThrow({ where: { id: ids.loan } })).startDate
    // One fix to move about: the device's newest (the trail keeps the others; they are not this test's subject).
    await testSetup(database(), [`DELETE FROM "TelematicsPosition" WHERE "deviceId" = $1 AND "id" <> (
      SELECT "id" FROM "TelematicsPosition" WHERE "deviceId" = $1 ORDER BY "occurredAt" DESC LIMIT 1)`, ids.device])
    const only = await database().telematicsPosition.findFirstOrThrow({ where: { deviceId: ids.device } })
    expect(only.occurredAt.getTime()).toBeGreaterThanOrEqual(startOfNew.getTime())
    expect(await reveal(ids.loan)).toMatchObject({ kind: "ok", position: { occurredAt: only.occurredAt.toISOString() } })
    expect(await reveal(ids.oldLoan)).toEqual({ kind: "ok", none: true })
    // The same fix moved into the old loan's tenure: now only the old loan sees it.
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = $2 WHERE "id" = $1`, only.id, new Date(startOfNew.getTime() - 5 * 86_400_000)])
    expect(await reveal(ids.oldLoan)).toMatchObject({ kind: "ok", position: { simulated: true } })
    expect(await reveal(ids.loan)).toEqual({ kind: "ok", none: true })
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = $2 WHERE "id" = $1`, only.id, only.occurredAt])
    // A later loan that never ran (CANCELLED) does not end this loan's tenure.
    await testSetup(database(),
      [`INSERT INTO "LoanApplication" SELECT (jsonb_populate_record(NULL::"LoanApplication", to_jsonb(a) || jsonb_build_object('id', $2::text, 'reference', $2::text))).*
        FROM "LoanApplication" a WHERE a."id" = (SELECT "applicationId" FROM "Loan" WHERE "id" = $1)`, ids.loan, `cxapp_${t}`],
      [`INSERT INTO "Loan" SELECT (jsonb_populate_record(NULL::"Loan", to_jsonb(l) || jsonb_build_object('id', $2::text, 'reference', $2::text, 'applicationId', $3::text,
          'status', 'CANCELLED', 'startDate', now() - INTERVAL '3 days'))).* FROM "Loan" l WHERE l."id" = $1`, ids.loan, `cx_${t}`, `cxapp_${t}`])
    expect(await reveal(ids.loan)).toMatchObject({ kind: "ok", position: { occurredAt: only.occurredAt.toISOString() } })
    // A later loan that ran, started yesterday at 10:00 SAST, ends this tenure at yesterday's SAST day start, as the database does:
    // a fix from 08:00 SAST yesterday is not this loan's.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await testSetup(database(),
      [`INSERT INTO "LoanApplication" SELECT (jsonb_populate_record(NULL::"LoanApplication", to_jsonb(a) || jsonb_build_object('id', $2::text, 'reference', $2::text))).*
        FROM "LoanApplication" a WHERE a."id" = (SELECT "applicationId" FROM "Loan" WHERE "id" = $1)`, ids.loan, `nxapp_${t}`],
      [`INSERT INTO "Loan" SELECT (jsonb_populate_record(NULL::"Loan", to_jsonb(l) || jsonb_build_object('id', $2::text, 'reference', $2::text, 'applicationId', $3::text,
          'status', 'COMPLETED', 'startDate', $4::timestamp))).* FROM "Loan" l WHERE l."id" = $1`, ids.loan, `nx_${t}`, `nxapp_${t}`, `${yesterday} 08:00:00`],
      [`UPDATE "TelematicsPosition" SET "occurredAt" = $2::timestamp WHERE "id" = $1`, only.id, `${yesterday} 06:00:00`])
    expect(await reveal(ids.loan)).toEqual({ kind: "ok", none: true })
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'CANCELLED' WHERE "id" = $1`, `nx_${t}`],
      [`UPDATE "TelematicsPosition" SET "occurredAt" = $2 WHERE "id" = $1`, only.id, only.occurredAt])
    // A tenure that has not begun shows nothing, though the asset has a position.
    await testSetup(database(), [`UPDATE "Loan" SET "startDate" = now() + INTERVAL '1 day' WHERE "id" = $1`, ids.loan])
    expect(await reveal(ids.loan)).toEqual({ kind: "ok", none: true })
    await testSetup(database(), [`UPDATE "Loan" SET "startDate" = $2 WHERE "id" = $1`, ids.loan, startOfNew])
    // Retention 1 day: the view filters even before the purge has run.
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 1 } })
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = "occurredAt" - INTERVAL '2 days' WHERE "deviceId" = $1`, ids.device])
    expect(await reveal(ids.loan)).toEqual({ kind: "ok", none: true })
    const none = await database().telematicsPositionAccess.findFirstOrThrow({ where: { loanId: ids.loan }, orderBy: { createdAt: "desc" } })
    expect(none).toMatchObject({ positionId: null, positionOccurredAt: null, userId: ids.collector })
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 90 } })
  }, 120_000)

  it("keeps the access log append-only: no update, delete or truncate", async () => {
    const row = await database().telematicsPositionAccess.findFirstOrThrow({ where: { loanId: ids.loan } })
    const rule = { table: "TelematicsPositionAccess", trigger: "TelematicsPositionAccess_guard" }
    await ruleRefuses(database(), rule, /append-only/, (tx) => tx.telematicsPositionAccess.update({ where: { id: row.id }, data: { userAgent: "edited" } }))
    await ruleRefuses(database(), rule, /append-only/, (tx) => tx.telematicsPositionAccess.delete({ where: { id: row.id } }))
    await ruleRefuses(database(), { table: "TelematicsPositionAccess", trigger: "TelematicsPositionAccess_no_truncate" }, /append-only/,
      (tx) => tx.$executeRawUnsafe(`TRUNCATE "TelematicsPositionAccess"`))
  }, 120_000)
})
