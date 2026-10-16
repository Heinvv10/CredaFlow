/**
 * Real-Postgres proof of a SIMULATED Section 129 notice (a demo stack's
 * undeliverable mailbox, lib/collections/section129-email.ts): it is recorded
 * apart from an issued notice, keeps that through reconciliation, is not
 * counted as sent for the NCR return, carries no admin charge, and still lets
 * the demo's collections flow continue (attorney referral, legal matter).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/section129-simulated.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant, NOW, SCHEDULE_TOTAL } from "@/lib/loan/charges.integration-fixture"
import {
  finaliseSection129Issuance,
  markSection129ReconciliationRequired,
  recoverStaleSection129Issuance,
  SECTION129_STALE_RESERVATION_MS,
  type Section129RecordData,
} from "@/lib/collections/section129-artifact"
import { SECTION129_ON_RECORD_WHERE, section129SentInPeriodWhere } from "@/lib/collections/section129-reporting"
import { latestSection129Failures } from "@/lib/collections/section129-failures"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

async function reservedNotice(lifecycle: "DISPATCHING" | "READY", extra: Partial<Section129RecordData> = {}) {
  const ids = await createChargesLoan(db, await createChargesTenant(db, true))
  const at = new Date("2026-09-26T09:00:00+02:00")
  const recordData = {
    lifecycle, loanReference: "LN", clientName: "C T", clientEmail: "c@fairscore.invalid",
    clientFirstName: "C", clientLastName: "T", clientIdNumber: "9001015800080", clientAddressLine1: null, clientCity: null,
    arrearsAmount: SCHEDULE_TOTAL, outstandingPrincipal: 200_000, daysInArrears: 95, noticeDate: "2026-09-26",
    fileName: "s129.pdf", pdfSha256: "a".repeat(64), reservedById: ids.userId, reservedAt: at.toISOString(), dispatchStartedAt: at.toISOString(),
    ...extra,
  } satisfies Section129RecordData
  const idempotencyKey = `s129-sim-${ids.loanId}`
  const record = await db.complianceRecord.create({
    data: { tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, idempotencyKey, status: "PENDING", data: recordData },
  })
  const reservation = { issuanceId: record.id, idempotencyKey, pdfSha256: "a".repeat(64), recordData: recordData as Section129RecordData }
  return { ids, record, reservation }
}

const audits = (tenantId: string) =>
  db.auditLog.findMany({ where: { tenantId, action: { startsWith: "SECTION_129_" } }, orderBy: { createdAt: "asc" }, select: { action: true, newValue: true } })

suite.sequential("simulated Section 129 notices (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect() })
  beforeEach(() => { vi.setSystemTime(NOW) })

  it("records a simulated notice as SIMULATED with its own audit action, and no admin charge", async () => {
    const { ids, record, reservation } = await reservedNotice("DISPATCHING")
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation, tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId,
      emailMessageId: "simulated-s129-1", issuedAt: new Date("2026-09-26T09:30:00+02:00"), simulated: true,
    }))
    const stored = await db.complianceRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(stored).toMatchObject({ status: "COMPLETED", data: expect.objectContaining({ lifecycle: "SIMULATED", simulated: true }) })
    expect(stored.data).not.toHaveProperty("adminChargeCents")
    expect(stored.data).not.toHaveProperty("adminChargeAt")
    expect((await audits(ids.tenantId)).map((row) => row.action)).toContain("SECTION_129_SIMULATED")
    expect((await audits(ids.tenantId)).map((row) => row.action)).not.toContain("SECTION_129_ISSUED")
    // A letter that was not sent carries no default administration charge.
    expect(await db.loanCharge.count({ where: { loanId: ids.loanId, sourceId: record.id } })).toBe(0)
  })

  it("control: an issued notice does carry its admin charge", async () => {
    const { ids, record, reservation } = await reservedNotice("DISPATCHING")
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation, tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId,
      emailMessageId: "m-issued", issuedAt: new Date("2026-09-26T09:30:00+02:00"),
    }))
    expect(await db.loanCharge.count({ where: { loanId: ids.loanId, sourceId: record.id } })).toBeGreaterThan(0)
    expect((await db.complianceRecord.findUniqueOrThrow({ where: { id: record.id } })).data).toHaveProperty("adminChargeCents")
  })

  it("keeps it simulated through reconciliation", async () => {
    const { ids, record, reservation } = await reservedNotice("DISPATCHING")
    await runWithTenant(ids.tenantId, () => markSection129ReconciliationRequired({
      reservation, tenantId: ids.tenantId, loanId: ids.loanId, actorId: ids.userId,
      reason: "Finalisation failed after the simulated dispatch", providerMessageId: "simulated-s129-2", simulated: true,
    }))
    const held = await db.complianceRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(held.data).toMatchObject({ lifecycle: "RECONCILIATION_REQUIRED", simulated: true })

    // The reconcile route finalises from the stored reservation, passing no flag.
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation: { ...reservation, recordData: held.data as Section129RecordData },
      tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId, emailMessageId: "simulated-s129-2",
      reconciliationReason: "Reconciled by staff after the outage", issuedAt: new Date("2026-09-26T09:30:00+02:00"),
    }))
    expect((await db.complianceRecord.findUniqueOrThrow({ where: { id: record.id } })).data).toMatchObject({ lifecycle: "SIMULATED" })
    expect((await audits(ids.tenantId)).map((row) => row.action)).toContain("SECTION_129_SIMULATION_RECONCILED")
  })

  // A crash during a simulated dispatch rolls the row back to READY; the flag
  // recorded at reservation must survive stale recovery and reconciliation.
  it("keeps a reservation's simulated flag through stale recovery and the reconciliation after it", async () => {
    const { ids, record, reservation } = await reservedNotice("READY", { simulated: true })
    const recovered = await runWithTenant(ids.tenantId, () => recoverStaleSection129Issuance({
      tenantId: ids.tenantId, loanId: ids.loanId, issuanceId: record.id, actorId: ids.userId,
      now: new Date(Date.parse(reservation.recordData.reservedAt) + SECTION129_STALE_RESERVATION_MS + 1),
    }))
    expect(recovered).toMatchObject({ kind: "RECONCILIATION_REQUIRED", previousLifecycle: "READY" })
    const held = await db.complianceRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(held.data).toMatchObject({ lifecycle: "RECONCILIATION_REQUIRED", simulated: true })

    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation: { ...reservation, recordData: held.data as Section129RecordData },
      tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId, emailMessageId: "simulated-s129-stale",
      reconciliationReason: "Reconciled by staff after the crash", issuedAt: new Date("2026-09-26T09:30:00+02:00"),
    }))
    const stored = await db.complianceRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(stored.data).toMatchObject({ lifecycle: "SIMULATED", simulated: true })
    expect(stored.data).not.toHaveProperty("adminChargeCents")
  })

  it("is not counted as sent for the NCR return, but stays on record for the collections flow", async () => {
    const { ids, reservation } = await reservedNotice("DISPATCHING")
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation, tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId,
      emailMessageId: "simulated-s129-3", issuedAt: new Date("2026-09-26T09:30:00+02:00"), simulated: true,
    }))
    const quarter = { start: new Date("2026-07-01T00:00:00+02:00"), end: new Date("2026-10-01T00:00:00+02:00") }
    expect(await db.complianceRecord.count({ where: section129SentInPeriodWhere(ids.tenantId, quarter.start, quarter.end) })).toBe(0)
    expect(await db.complianceRecord.count({
      where: { tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, status: "COMPLETED", ...SECTION129_ON_RECORD_WHERE },
    })).toBe(1)
  })

  it("reads the latest not-sent attempt's reason per loan (the queue's query)", async () => {
    const { ids } = await reservedNotice("DISPATCHING")
    await db.complianceRecord.create({
      data: {
        tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, status: "OVERDUE",
        data: { lifecycle: "FAILED", failedAt: "2026-09-26T08:00:00.000Z", failureReason: "Email not configured for this tenant. Go to Settings → Email." },
      },
    })
    // The newest record (the FAILED one above) decides.
    const failures = await runWithTenant(ids.tenantId, () => latestSection129Failures(ids.tenantId, [ids.loanId]))
    expect(failures.get(ids.loanId)).toEqual({ failedAt: new Date("2026-09-26T08:00:00.000Z"), reason: "Email not configured for this tenant. Go to Settings → Email." })
  })
})
