/**
 * Real-Postgres proof of the bureau submission ledger: the once-only index,
 * the monthly population against what was already sent, the reopened-loan
 * hold, the byte-identical re-download and the post-period hold. Receipts and
 * reversals go through the real writers; only auth and the tenant frame of the
 * reversal route are stubbed.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/bureau-submission/generate.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { INSTALMENT, createBureauLoan, createBureauTenant, invalidSaId, sast, type BureauTenant } from "./bureau.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.userId, email: "bureau-it@test.invalid", role: "SUPER_ADMIN" },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
  getDefaultTenantId: async () => ctx.tenantId,
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { PATCH as reverse } from "@/app/api/payments/[id]/reverse/route"
import { generateMonthly, type GenerateResult } from "./generate"
import { parseRecord } from "./layout"
import { renderSubmission } from "./render"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

const at = (time: Date) => vi.setSystemTime(time)

async function tenant(config?: Parameters<typeof createBureauTenant>[1]): Promise<BureauTenant> {
  const created = await createBureauTenant(db, config)
  ctx.tenantId = created.tenantId
  ctx.userId = created.userId
  return created
}

const pay = async (t: BureauTenant, loanId: string, amount: number, receivedAt: Date) => {
  at(receivedAt)
  return (await runWithTenant(t.tenantId, () => applyManualReceipt(prisma, {
    loanId, tenantId: t.tenantId, amount, receivedAt, capturedById: t.userId,
  }))).payment
}

/** Generate the monthly file for `periodDay` on the 1st of the next month, 00:30 SAST. */
async function monthly(t: BureauTenant, periodDay: string, mode: "LIVE" | "TEST" = "LIVE", generatedOn?: Date) {
  const now = generatedOn ?? new Date(new Date(`${periodDay}T22:30:00.000Z`))
  at(now)
  return runWithTenant(t.tenantId, () => generateMonthly(prisma, {
    tenantId: t.tenantId, periodDay, mode, now, actor: { source: "staff", userId: t.userId },
  }))
}

function generated(result: GenerateResult) {
  if (result.outcome !== "GENERATED") throw new Error(`expected GENERATED, got ${result.outcome}`)
  return result
}

/** Sent lines of a submission keyed by account number, and held reasons by loan. */
async function ledger(submissionId: string) {
  const records = await db.bureauSubmissionRecord.findMany({ where: { submissionId }, orderBy: { lineNo: "asc" } })
  return {
    sent: records.filter((r) => r.heldReason === null),
    held: new Map(records.filter((r) => r.heldReason !== null).map((r) => [r.loanId, r.heldReason])),
    sentLoanIds: records.filter((r) => r.heldReason === null).map((r) => r.loanId),
  }
}

suite.sequential("bureau submission ledger (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: sast("2026-07-01") }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })

  describe("the once-only index", () => {
    it("rejects a second LIVE closing status for the same loan and kind, and exempts TEST and held rows", async () => {
      const t = await tenant()
      const loan = await createBureauLoan(db, t)
      const submission = (mode: "LIVE" | "TEST", sequence: number) => db.bureauSubmission.create({
        data: {
          tenantId: t.tenantId, kind: "MONTHLY", periodDate: new Date("2026-08-31T00:00:00.000Z"), mode, sequence,
          fileName: `IT_${mode}_${sequence}`, sha256: "x", recordCount: 1, heldCount: 0,
        },
      })
      const record = (submissionId: string, over: { mode?: "LIVE" | "TEST"; kind?: "MONTHLY" | "DAILY"; statusCode?: string; heldReason?: string } = {}) =>
        db.bureauSubmissionRecord.create({
          data: {
            tenantId: t.tenantId, submissionId, kind: over.kind ?? "MONTHLY", mode: over.mode ?? "LIVE", loanId: loan.loanId,
            dataFlag: "D", statusCode: over.statusCode ?? "C", fields: {}, heldReason: over.heldReason ?? null,
          },
        })
      const first = await submission("LIVE", 1)
      const second = await submission("LIVE", 2)
      const test = await submission("TEST", 1)

      await record(first.id)
      await expect(record(second.id)).rejects.toMatchObject({ code: "P2002" })
      // Not the same guard: a different status, a held row, a daily row, a TEST row.
      await expect(record(second.id, { statusCode: "W" })).resolves.toBeTruthy()
      await expect(record(second.id, { heldReason: "INVALID_SA_ID" })).resolves.toBeTruthy()
      await expect(record(second.id, { kind: "DAILY" })).resolves.toBeTruthy()
      await expect(record(test.id, { mode: "TEST" })).resolves.toBeTruthy()
      await expect(record(test.id, { mode: "TEST" })).resolves.toBeTruthy()
      // An open loan's status-less row may repeat every month.
      await db.bureauSubmissionRecord.create({ data: { tenantId: t.tenantId, submissionId: first.id, kind: "MONTHLY", mode: "LIVE", loanId: loan.loanId, dataFlag: "D", fields: {} } })
      await db.bureauSubmissionRecord.create({ data: { tenantId: t.tenantId, submissionId: second.id, kind: "MONTHLY", mode: "LIVE", loanId: loan.loanId, dataFlag: "D", fields: {} } })
    })
  })

  describe("a closed loan", () => {
    it("appears once with its closure, is absent the following month, and is held when a reversal reopens it", async () => {
      const t = await tenant()
      const closing = await createBureauLoan(db, t)
      const open = await createBureauLoan(db, t)
      await pay(t, closing.loanId, INSTALMENT, sast("2026-07-30"))
      const settling = await pay(t, closing.loanId, INSTALMENT, sast("2026-08-20"))
      expect((await db.loan.findUniqueOrThrow({ where: { id: closing.loanId } })).status).toBe("COMPLETED")

      // August: both loans, the settled one closed early (T) with zeroed balances.
      const august = generated(await monthly(t, "2026-08-31"))
      expect(august.recordCount).toBe(2)
      expect(august.heldCount).toBe(0)
      const augustLedger = await ledger(august.submissionId)
      const closure = augustLedger.sent.find((r) => r.loanId === closing.loanId)!
      expect(closure.statusCode).toBe("T")
      expect(closure.statusDate?.toISOString().slice(0, 10)).toBe("2026-08-20")
      expect((closure.fields as Record<string, string>).currentBalance).toBe("000000000")
      const stillOpen = augustLedger.sent.find((r) => r.loanId === open.loanId)!
      expect(stillOpen.statusCode).toBeNull()
      // R1,000 owed, the 1 Aug instalment 30 days overdue at 31 Aug.
      expect((stillOpen.fields as Record<string, string>)).toMatchObject({
        currentBalance: "000001000", amountOverdue: "000000500", monthsInArrears: "01", accountType: "P",
      })

      // September: the closure is not repeated; the open loan still reports.
      const september = generated(await monthly(t, "2026-09-30"))
      expect((await ledger(september.submissionId)).sentLoanIds).toEqual([open.loanId])

      // 5 Oct: the settling debit order bounces. The loan is open again.
      at(sast("2026-10-05"))
      const response = await reverse(
        new NextRequest("http://localhost/api/test", { method: "PATCH", body: JSON.stringify({ reason: "Debit order returned unpaid" }) }),
        { params: Promise.resolve({ id: settling.id }) },
      )
      expect(response.status).toBe(200)
      expect((await db.loan.findUniqueOrThrow({ where: { id: closing.loanId } })).status).toBe("ACTIVE")

      // October: held, never silently re-registered.
      const october = generated(await monthly(t, "2026-10-31"))
      const octoberLedger = await ledger(october.submissionId)
      expect(octoberLedger.sentLoanIds).toEqual([open.loanId])
      expect(octoberLedger.held.get(closing.loanId)).toBe("REOPENED_AFTER_CLOSURE")
      expect(october.heldByReason).toEqual({ REOPENED_AFTER_CLOSURE: 1 })
    })

    it("is included again when a TEST file is regenerated, because TEST rows are not what the bureau was told", async () => {
      const t = await tenant()
      const closing = await createBureauLoan(db, t)
      await pay(t, closing.loanId, 2 * INSTALMENT, sast("2026-08-20"))
      const first = generated(await monthly(t, "2026-08-31", "TEST"))
      expect((await ledger(first.submissionId)).sent[0].statusCode).toBe("T")
      const again = generated(await monthly(t, "2026-08-31", "TEST"))
      expect((await ledger(again.submissionId)).sent[0].statusCode).toBe("T")
      expect(again.fileName).toBe("TT0109_ALL_T702_M_20260831_1_2")
    })

    it("keeps only the newest TEST file's lines: the older copy of the book's personal data is dropped", async () => {
      const t = await tenant()
      await createBureauLoan(db, t)
      await createBureauLoan(db, t, { idNumber: invalidSaId() })
      const first = generated(await monthly(t, "2026-08-31", "TEST"))
      expect(await db.bureauSubmissionRecord.count({ where: { submissionId: first.submissionId } })).toBe(2)
      const second = generated(await monthly(t, "2026-08-31", "TEST"))
      expect(await db.bureauSubmissionRecord.count({ where: { submissionId: first.submissionId } })).toBe(0)
      expect(await db.bureauSubmissionRecord.count({ where: { submissionId: second.submissionId } })).toBe(2)
      expect(await renderSubmission(prisma, t.tenantId, first.submissionId)).toMatchObject({ superseded: true, intact: false })
      expect(await renderSubmission(prisma, t.tenantId, second.submissionId)).toMatchObject({ superseded: false, intact: true })
      // Another period's TEST file and a LIVE file are not touched.
      const july = generated(await monthly(t, "2026-07-31", "TEST", sast("2026-09-02")))
      const live = generated(await monthly(t, "2026-08-31", "LIVE"))
      generated(await monthly(t, "2026-08-31", "TEST"))
      expect(await db.bureauSubmissionRecord.count({ where: { submissionId: july.submissionId } })).toBe(2)
      expect(await db.bureauSubmissionRecord.count({ where: { submissionId: live.submissionId } })).toBe(2)
    })
  })

  describe("a re-run in LIVE mode", () => {
    it("creates the next sequence and never overwrites", async () => {
      const t = await tenant()
      await createBureauLoan(db, t)
      const first = generated(await monthly(t, "2026-08-31"))
      const second = generated(await monthly(t, "2026-08-31"))
      expect(first.fileName).toBe("TT0109_ALL_L702_M_20260831_1_1")
      expect(second.fileName).toBe("TT0109_ALL_L702_M_20260831_1_2")
      expect(second.submissionId).not.toBe(first.submissionId)
      expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(2)
      expect(await db.auditLog.count({ where: { tenantId: t.tenantId, action: "BUREAU_SUBMISSION_GENERATED" } })).toBe(2)
    })
  })

  describe("a re-download", () => {
    it("is byte-identical after the live loan and client columns change, and detects a tampered ledger", async () => {
      const t = await tenant()
      const loan = await createBureauLoan(db, t, { lastName: "Original" })
      const result = generated(await monthly(t, "2026-08-31"))
      const before = (await renderSubmission(prisma, t.tenantId, result.submissionId))!
      expect(before.intact).toBe(true)
      expect(before.content).toContain("ORIGINAL")
      const lines = before.content.split("\r\n")
      expect(lines).toHaveLength(4) // header, one record, trailer, and the empty tail after the last CRLF
      expect(lines.slice(0, 3).every((line) => line.length === 700)).toBe(true)
      expect(parseRecord(lines[1], "MONTHLY").accountNumber).toBe(loan.reference)

      await db.client.update({ where: { id: loan.clientId }, data: { lastName: "Changed", addressLine1: "1 New Street" } })
      await db.loan.update({ where: { id: loan.loanId }, data: { totalPaid: 99_900, arrearsAmount: 12_345, daysInArrears: 77 } })
      await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { bureauTradingName: "Renamed Lender" } })

      const after = (await renderSubmission(prisma, t.tenantId, result.submissionId))!
      expect(after.content).toBe(before.content)
      expect(after.intact).toBe(true)

      // The stored hash is what proves it: edit a snapshot and the proof fails.
      const row = await db.bureauSubmissionRecord.findFirstOrThrow({ where: { submissionId: result.submissionId } })
      await db.bureauSubmissionRecord.update({
        where: { id: row.id }, data: { fields: { ...(row.fields as Record<string, string>), currentBalance: "000000001" } },
      })
      expect((await renderSubmission(prisma, t.tenantId, result.submissionId))!.intact).toBe(false)
    })

    it("is not readable by another tenant", async () => {
      const t = await tenant()
      await createBureauLoan(db, t)
      const result = generated(await monthly(t, "2026-08-31"))
      const other = await createBureauTenant(db)
      expect(await renderSubmission(prisma, other.tenantId, result.submissionId)).toBeNull()
    })
  })

  describe("activity after the period date", () => {
    it("holds a loan with a receipt dated after the period as POST_PERIOD_ACTIVITY", async () => {
      const t = await tenant()
      const paidLater = await createBureauLoan(db, t)
      const untouched = await createBureauLoan(db, t)
      await pay(t, paidLater.loanId, INSTALMENT, sast("2026-09-03"))

      const result = generated(await monthly(t, "2026-08-31", "LIVE", sast("2026-09-04")))
      const augustLedger = await ledger(result.submissionId)
      expect(augustLedger.sentLoanIds).toEqual([untouched.loanId])
      expect(augustLedger.held.get(paidLater.loanId)).toBe("POST_PERIOD_ACTIVITY")
      // The September receipt is not the August file's "date of last payment" either.
      const heldRow = await db.bureauSubmissionRecord.findFirstOrThrow({ where: { submissionId: result.submissionId, loanId: paidLater.loanId } })
      expect((heldRow.fields as Record<string, string>).lastPaymentDate).toBe("")
    })

    it("holds a loan whose in-period receipt was reversed after the period", async () => {
      const t = await tenant()
      const loan = await createBureauLoan(db, t)
      const receipt = await pay(t, loan.loanId, INSTALMENT, sast("2026-08-20"))
      at(sast("2026-09-03"))
      const response = await reverse(
        new NextRequest("http://localhost/api/test", { method: "PATCH", body: JSON.stringify({ reason: "Debit order returned unpaid" }) }),
        { params: Promise.resolve({ id: receipt.id }) },
      )
      expect(response.status).toBe(200)
      const result = generated(await monthly(t, "2026-08-31", "LIVE", sast("2026-09-04")))
      expect((await ledger(result.submissionId)).held.get(loan.loanId)).toBe("POST_PERIOD_ACTIVITY")
    })

    it("holds a loan closed after the period, and one written off after it, even with no receipt since", async () => {
      const t = await tenant()
      const closedLater = await createBureauLoan(db, t)
      const writtenOffLater = await createBureauLoan(db, t)
      const untouched = await createBureauLoan(db, t)
      await db.loan.update({ where: { id: closedLater.loanId }, data: { status: "COMPLETED", closedAt: sast("2026-09-02") } })
      await db.loan.update({ where: { id: writtenOffLater.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: sast("2026-09-03") } })
      const result = generated(await monthly(t, "2026-08-31", "LIVE", sast("2026-09-04")))
      const augustLedger = await ledger(result.submissionId)
      expect(augustLedger.sentLoanIds).toEqual([untouched.loanId])
      expect(augustLedger.held.get(closedLater.loanId)).toBe("POST_PERIOD_ACTIVITY")
      expect(augustLedger.held.get(writtenOffLater.loanId)).toBe("POST_PERIOD_ACTIVITY")
    })

    it("does not hold a loan whose receipt is dated inside the period", async () => {
      const t = await tenant()
      const loan = await createBureauLoan(db, t)
      await pay(t, loan.loanId, INSTALMENT, sast("2026-08-31", "23:30:00"))
      const result = generated(await monthly(t, "2026-08-31"))
      const { sent } = await ledger(result.submissionId)
      expect(sent).toHaveLength(1)
      expect((sent[0].fields as Record<string, string>)).toMatchObject({ currentBalance: "000000500", lastPaymentDate: "20260831" })
    })
  })

  describe("the population", () => {
    it("leaves out PO funding, loans not yet open, loans closed before the reporting start, and another tenant's loans", async () => {
      const t = await tenant()
      const personal = await createBureauLoan(db, t)
      const micro = await createBureauLoan(db, t, { productType: "MICRO" })
      await createBureauLoan(db, t, { productType: "PO_FUNDING" })
      await createBureauLoan(db, t, { startDay: "2026-09-02", dueDays: ["2026-10-02", "2026-11-02"] })
      const longClosed = await createBureauLoan(db, t, { startDay: "2026-03-01", dueDays: ["2026-04-01", "2026-05-01"] })
      await db.loan.update({ where: { id: longClosed.loanId }, data: { status: "COMPLETED", closedAt: sast("2026-05-01") } })
      const writtenOffBefore = await createBureauLoan(db, t, { startDay: "2026-01-01", dueDays: ["2026-02-01", "2026-03-01"] })
      await db.loan.update({ where: { id: writtenOffBefore.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: sast("2026-05-15") } })
      const other = await createBureauTenant(db)
      await createBureauLoan(db, other)

      const result = generated(await monthly(t, "2026-08-31"))
      const { sent } = await ledger(result.submissionId)
      expect(sent.map((r) => r.loanId).sort()).toEqual([personal.loanId, micro.loanId].sort())
      const types = new Map(sent.map((r) => [r.loanId, (r.fields as Record<string, string>).accountType]))
      expect(types.get(personal.loanId)).toBe("P")
      expect(types.get(micro.loanId)).toBe("M")
      expect(result.heldCount).toBe(0)
    })

    it("holds a record that fails validation and sends the rest", async () => {
      const t = await tenant()
      const good = await createBureauLoan(db, t)
      const bad = await createBureauLoan(db, t, { idNumber: invalidSaId() })
      const result = generated(await monthly(t, "2026-08-31"))
      const augustLedger = await ledger(result.submissionId)
      expect(augustLedger.sentLoanIds).toEqual([good.loanId])
      expect(augustLedger.held.get(bad.loanId)).toBe("INVALID_SA_ID")
      const rendered = (await renderSubmission(prisma, t.tenantId, result.submissionId))!
      expect(rendered.content.split("\r\n")[2].slice(0, 10)).toBe("T000000003")
    })
  })

  describe("a record that cannot go in the file", () => {
    it("sends a mandated loan under its 25-character id, and still holds a reference that cannot fit", async () => {
      const t = await tenant()
      const mandated = await createBureauLoan(db, t)
      const unfixable = await createBureauLoan(db, t)
      const application = await db.loan.findUniqueOrThrow({ where: { id: mandated.loanId }, select: { applicationId: true } })
      expect(application.applicationId).toHaveLength(25)
      // What disbursement writes when the debit mandate's collection reference is the default.
      await db.loan.update({ where: { id: mandated.loanId }, data: { reference: `LN-${application.applicationId}` } })
      await db.loan.update({ where: { id: unfixable.loanId }, data: { reference: `REF-${unfixable.reference}-${"X".repeat(12)}` } })

      const result = generated(await monthly(t, "2026-08-31"))
      const augustLedger = await ledger(result.submissionId)
      expect(augustLedger.sentLoanIds).toEqual([mandated.loanId])
      expect((augustLedger.sent[0].fields as Record<string, string>).accountNumber).toBe(application.applicationId.toUpperCase())
      expect(augustLedger.held.get(unfixable.loanId)).toBe("INVALID_ACCOUNT_NUMBER")
      const line = (await renderSubmission(prisma, t.tenantId, result.submissionId))!.content.split("\r\n")[1]
      expect(line.slice(47, 72)).toBe(application.applicationId.toUpperCase())
    })

    it("holds both loans whose references differ only in case, and sends the rest", async () => {
      const t = await tenant()
      const good = await createBureauLoan(db, t)
      const upper = await createBureauLoan(db, t)
      const lower = await createBureauLoan(db, t)
      await db.loan.update({ where: { id: lower.loanId }, data: { reference: upper.reference.toLowerCase() } })
      const result = generated(await monthly(t, "2026-08-31"))
      const augustLedger = await ledger(result.submissionId)
      expect(augustLedger.sentLoanIds).toEqual([good.loanId])
      expect(augustLedger.held.get(upper.loanId)).toBe("DUPLICATE_ACCOUNT_NUMBER")
      expect(augustLedger.held.get(lower.loanId)).toBe("DUPLICATE_ACCOUNT_NUMBER")
    })
  })

  describe("the header", () => {
    it("cleans the trading name and refuses a supplier number that is not a short alphanumeric code", async () => {
      const t = await tenant()
      await createBureauLoan(db, t)
      await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { bureauTradingName: "Bureau IT\r\nT000000002" } })
      const result = generated(await monthly(t, "2026-08-31"))
      const lines = (await renderSubmission(prisma, t.tenantId, result.submissionId))!.content.split("\r\n")
      expect(lines).toHaveLength(4)
      expect(lines[0].slice(29, 89).trim()).toBe("BUREAU IT T000000002")

      for (const supplier of ['a"; x=', "TT 0109", "ABCDEFGHIJK", "TT\r\n01"]) {
        await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { bureauSupplierNumber: supplier } })
        expect((await monthly(t, "2026-08-31")).outcome, supplier).toBe("NOT_CONFIGURED")
      }
      expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(1)
    })
  })

  describe("concurrent runs", () => {
    it("never send the same thing twice: an overlapping run is refused, not duplicated", async () => {
      const t = await tenant()
      const loan = await createBureauLoan(db, t)
      await pay(t, loan.loanId, 2 * INSTALMENT, sast("2026-08-20"))
      const now = sast("2026-09-01", "00:30:00")
      at(now)
      const runs = await Promise.allSettled(Array.from({ length: 5 }, () => runWithTenant(t.tenantId, () =>
        generateMonthly(prisma, { tenantId: t.tenantId, periodDay: "2026-08-31", mode: "LIVE", now, actor: { source: "cron" } }))))
      const fulfilled = runs.filter((run) => run.status === "fulfilled")
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)
      for (const run of runs) {
        if (run.status === "rejected") expect(String(run.reason)).toMatch(/generated at the same time|Unique constraint/)
      }
      // However the five interleaved, the closure reached the ledger exactly once.
      expect(await db.bureauSubmissionRecord.count({ where: { loanId: loan.loanId, mode: "LIVE", statusCode: "T", heldReason: null } })).toBe(1)
      const sequences = (await db.bureauSubmission.findMany({ where: { tenantId: t.tenantId }, select: { sequence: true } })).map((s) => s.sequence).sort()
      expect(new Set(sequences).size).toBe(sequences.length)
    })
  })

  describe("a written-off loan", () => {
    it("reports arrears with no status until confirmed, then W once, then is dropped", async () => {
      const t = await tenant()
      const loan = await createBureauLoan(db, t)
      await db.loan.update({ where: { id: loan.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: sast("2026-09-10") } })

      const september = generated(await monthly(t, "2026-09-30"))
      const unconfirmed = (await ledger(september.submissionId)).sent[0]
      expect(unconfirmed.statusCode).toBeNull()
      expect((unconfirmed.fields as Record<string, string>)).toMatchObject({ amountOverdue: "000001000", monthsInArrears: "02", statusCode: "" })

      await db.bureauAdverseConfirmation.create({
        data: { tenantId: t.tenantId, loanId: loan.loanId, statusCode: "W", noticeDate: new Date("2026-10-02T00:00:00.000Z"), confirmedById: t.userId },
      })
      // Notice was given on 2 Oct: a re-run of September must still not list it.
      const septemberAgain = generated(await monthly(t, "2026-09-30", "TEST", sast("2026-10-03")))
      expect((await ledger(septemberAgain.submissionId)).sent[0].statusCode).toBeNull()
      const october = generated(await monthly(t, "2026-10-31"))
      const confirmed = (await ledger(october.submissionId)).sent[0]
      expect(confirmed.statusCode).toBe("W")
      expect((confirmed.fields as Record<string, string>)).toMatchObject({ statusCode: "W", statusDate: "20260910", amountOverdue: "000001000" })

      const november = generated(await monthly(t, "2026-11-30"))
      expect(november.recordCount).toBe(0)
      expect(november.heldCount).toBe(0)
    })
  })

  describe("configuration", () => {
    it("writes nothing while the feature flag is off or the supplier number is missing", async () => {
      const off = await tenant({ featureBureauSubmission: false })
      await createBureauLoan(db, off)
      expect((await monthly(off, "2026-08-31")).outcome).toBe("DISABLED")
      const unconfigured = await tenant({ bureauSupplierNumber: null })
      await createBureauLoan(db, unconfigured)
      expect((await monthly(unconfigured, "2026-08-31")).outcome).toBe("NOT_CONFIGURED")
      expect(await db.bureauSubmission.count({ where: { tenantId: { in: [off.tenantId, unconfigured.tenantId] } } })).toBe(0)
    })

    it("refuses a period before the reporting start date, one that is not a month end, and one that has not ended", async () => {
      const t = await tenant()
      expect((await monthly(t, "2026-05-31")).outcome).toBe("BEFORE_REPORTING_START")
      await expect(monthly(t, "2026-08-30")).rejects.toThrow(/not a month end/)
      await expect(monthly(t, "2026-08-31", "LIVE", sast("2026-08-31", "23:00:00"))).rejects.toThrow(/has not ended/)
    })
  })
})
