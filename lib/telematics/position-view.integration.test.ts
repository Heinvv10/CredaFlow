/**
 * The last known position on real Postgres (docs/asset-finance/SLICE5.md part
 * B, POPIA): revealed only to collections staff and above (never READONLY or
 * INSURANCE_OFFICER), only for a loan in default, legal action or recovery,
 * only from this loan's tenure of the asset and within retention; every
 * reveal, a "none" included, writes an access row first, and the log is
 * append-only.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/position-view.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleRefuses, testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { revealPosition } from "./position-view"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
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

  it("refuses READONLY and INSURANCE_OFFICER with 403 and logs nothing", async () => {
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.loan])
    expect(await revealPosition(as(ids.readonly, "READONLY"), ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "refused", status: 403 })
    expect(await revealPosition(as(ids.insurance, "INSURANCE_OFFICER"), ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "refused", status: 403 })
    expect(await revealPosition(as(ids.collector, "DEALER"), ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "refused", status: 403 })
    expect(await accessRows()).toBe(0)
  }, 120_000)

  it("shows a collections officer the latest position with its time, and logs who, when, which loan and which position", async () => {
    const result = await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "RECOVERY" }, meta)
    const latest = await database().telematicsPosition.findFirstOrThrow({ where: { deviceId: ids.device }, orderBy: { occurredAt: "desc" } })
    expect(result).toMatchObject({ kind: "ok", position: {
      latitude: Number(latest.latitude), longitude: Number(latest.longitude), accuracyM: latest.accuracyM, occurredAt: latest.occurredAt.toISOString(), simulated: true,
    } })
    const [row] = await database().telematicsPositionAccess.findMany({ where: { loanId: ids.loan } })
    expect(row).toMatchObject({ userId: ids.collector, context: "RECOVERY", positionId: latest.id, positionOccurredAt: latest.occurredAt, deviceId: ids.device, ipAddress: meta.ipAddress })
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: { startsWith: "TELEMATICS_POSITION" } } })).toBe(0)
  }, 120_000)

  it("refuses a running loan with no default, legal action or recovery (409, not logged); legal action opens it; LEGAL_MATTER needs the matter", async () => {
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'ACTIVE' WHERE "id" = $1`, ids.loan])
    const before = await accessRows()
    expect(await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "RECOVERY" }, meta))
      .toMatchObject({ kind: "refused", status: 409, error: "Position is shown only for a loan in default, legal action or recovery" })
    await testSetup(database(), [`INSERT INTO "Recovery" ("id", "tenantId", "loanId", "assetId", "route", "status", "recoveredOn", "location", "condition", "createdById", "closedAt", "withdrawnReason", "updatedAt")
      VALUES ($1, $2, $3, $4, 'NON_NCA_COURT_ORDER', 'WITHDRAWN', CURRENT_DATE, 'Synthetic yard', 'Synthetic condition', $5, now(), 'Synthetic withdrawal', now())`, `rc_${t}`, fx.tenantId, ids.loan, fx.assets[1], fx.adminA])
    expect(await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    expect(await accessRows()).toBe(before)
    const recovery = (status: string) => testSetup(database(), [`UPDATE "Recovery" SET "status" = $2::"RecoveryStatus",
      "closedAt" = CASE WHEN $2 = 'WITHDRAWN' THEN now() END, "withdrawnReason" = CASE WHEN $2 = 'WITHDRAWN' THEN 'Synthetic withdrawal' END WHERE "id" = $1`, `rc_${t}`, status])
    await recovery("RECOVERED")
    expect(await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "ok", position: { simulated: true } })
    await recovery("WITHDRAWN")
    await testSetup(database(), [`INSERT INTO "LegalMatter" ("id", "tenantId", "loanId", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, now())`, `lm_${t}`, fx.tenantId, ids.loan, fx.adminA])
    expect(await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "LEGAL_MATTER" }, meta)).toMatchObject({ kind: "ok", position: { simulated: true } })
    await testSetup(database(), [`UPDATE "LegalMatter" SET "status" = 'CLOSED', "closedAt" = now() WHERE "id" = $1`, `lm_${t}`],
      [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.loan])
    expect(await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "LEGAL_MATTER" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    expect(await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "SOMETHING" }, meta)).toMatchObject({ kind: "refused", status: 400 })
    expect(await accessRows()).toBe(before + 2)
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
    const mine = await revealPosition(collector, ids.loan, { context: "RECOVERY" }, meta)
    const old = await revealPosition(collector, ids.oldLoan, { context: "RECOVERY" }, meta)
    const startOfNew = (await database().loan.findUniqueOrThrow({ where: { id: ids.loan } })).startDate
    expect((mine as { position: { occurredAt: string } }).position.occurredAt >= startOfNew.toISOString()).toBe(true)
    expect((old as { position: { occurredAt: string } }).position.occurredAt < startOfNew.toISOString()).toBe(true)
    // A tenure that has not begun shows nothing, though the asset has older positions.
    await testSetup(database(), [`UPDATE "Loan" SET "startDate" = now() + INTERVAL '1 day' WHERE "id" = $1`, ids.loan])
    expect(await revealPosition(collector, ids.loan, { context: "RECOVERY" }, meta)).toEqual({ kind: "ok", none: true })
    await testSetup(database(), [`UPDATE "Loan" SET "startDate" = $2 WHERE "id" = $1`, ids.loan, startOfNew])
    // Retention 1 day: the view filters even before the purge has run.
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 1 } })
    await testSetup(database(), [`UPDATE "TelematicsPosition" SET "occurredAt" = "occurredAt" - INTERVAL '2 days' WHERE "deviceId" = $1`, ids.device])
    expect(await revealPosition(collector, ids.loan, { context: "RECOVERY" }, meta)).toEqual({ kind: "ok", none: true })
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
