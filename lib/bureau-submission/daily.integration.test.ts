/**
 * Real-Postgres proof of the daily file and both cron routes: a loan opened
 * and a loan settled on one day produce exactly one R and one C line, and the
 * monthly route then repeats that closure once. The settlement goes through
 * the real receipt writer; the routes are called as the scheduler calls them.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/bureau-submission/daily.integration.test.ts
 *
 * Run it with --no-file-parallelism (as scripts/run-integration-tests.sh does):
 * the routes act on every tenant with the flag on, so this suite parks the
 * others while it runs.
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { GET as dailyRoute } from "@/app/api/cron/bureau-daily/route"
import { GET as monthlyRoute } from "@/app/api/cron/bureau-monthly/route"
import { INSTALMENT, createBureauLoan, createBureauTenant, invalidSaId, sast, type BureauTenant } from "./bureau.integration-fixture"
import type { BureauCronRun, TenantRun } from "./cron"
import { generateDaily, generateMonthly, type GenerateResult } from "./generate"
import { parseRecord } from "./layout"
import { renderSubmission } from "./render"

vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const SECRET = "bureau-it-cron-secret"

const call = async (route: typeof dailyRoute, query: string, at: Date, secret = SECRET) => {
  vi.setSystemTime(at)
  const response = await route(new NextRequest(`http://localhost/api/cron/x${query}`, { headers: { "x-cron-secret": secret } }))
  return { status: response.status, body: (await response.json()) as BureauCronRun & { error?: string } }
}
const runFor = (body: BureauCronRun, t: BureauTenant) => body.perTenant.find((run) => run.tenantId === t.tenantId) as TenantRun
function generated(run: TenantRun) {
  if (run.outcome !== "GENERATED") throw new Error(`expected GENERATED, got ${run.outcome}`)
  return run
}
async function fileLines(t: BureauTenant, submissionId: string) {
  const rendered = (await renderSubmission(prisma, t.tenantId, submissionId))!
  expect(rendered.intact).toBe(true)
  expect(rendered.content.endsWith("\r\n")).toBe(true)
  return rendered.content.slice(0, -2).split("\r\n")
}

suite.sequential("bureau daily file and cron routes (real Postgres)", () => {
  let othersWithFlag: string[] = []
  const saved = { secret: process.env.CRON_SECRET, mode: process.env.BUREAU_SUBMISSION_MODE }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: sast("2026-07-01") })
    process.env.CRON_SECRET = SECRET
    delete process.env.BUREAU_SUBMISSION_MODE
    // The routes run every tenant with the flag on. Park the others (earlier
    // fixtures, a local demo book) so this suite measures only its own.
    othersWithFlag = (await db.tenantConfig.findMany({ where: { featureBureauSubmission: true }, select: { tenantId: true } })).map((c) => c.tenantId)
    await db.tenantConfig.updateMany({ where: { tenantId: { in: othersWithFlag } }, data: { featureBureauSubmission: false } })
  })
  afterAll(async () => {
    await db.tenantConfig.updateMany({ where: { featureBureauSubmission: true }, data: { featureBureauSubmission: false } })
    await db.tenantConfig.updateMany({ where: { tenantId: { in: othersWithFlag } }, data: { featureBureauSubmission: true } })
    process.env.CRON_SECRET = saved.secret
    process.env.BUREAU_SUBMISSION_MODE = saved.mode
    vi.useRealTimers()
    await db.$disconnect()
  })

  it("registers the loan opened and closes the loan settled that day, then the monthly repeats the closure once", async () => {
    const t = await createBureauTenant(db)
    const settling = await createBureauLoan(db, t, { startDay: "2026-07-01", dueDays: ["2026-08-01", "2026-09-01"] })
    const opened = await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
    await createBureauLoan(db, t, { productType: "PO_FUNDING", startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
    vi.setSystemTime(sast("2026-08-20", "14:00:00"))
    await runWithTenant(t.tenantId, () => applyManualReceipt(prisma, {
      loanId: settling.loanId, tenantId: t.tenantId, amount: 2 * INSTALMENT, receivedAt: sast("2026-08-20", "14:00:00"), capturedById: t.userId,
    }))

    // 21 Aug, 00:20 SAST: the scheduler's call, with no date — yesterday.
    const daily = await call(dailyRoute, "", sast("2026-08-21", "00:20:00"))
    expect(daily.status).toBe(200)
    expect(daily.body).toMatchObject({ ok: true, kind: "DAILY", mode: "TEST", day: "2026-08-20" })
    const dailyRun = generated(runFor(daily.body, t))
    expect(dailyRun).toMatchObject({ recordCount: 2, heldCount: 0, push: "NOT_CONFIGURED", fileName: "TT0109_ALL_T702_D_20260820_1_1" })

    const lines = await fileLines(t, dailyRun.submissionId)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toHaveLength(718)
    const records = lines.map((line) => parseRecord(line, "DAILY"))
    expect(records.map((r) => r.dataFlag).sort()).toEqual(["C", "R"])
    const registration = records.find((r) => r.dataFlag === "R")!
    expect(registration).toMatchObject({
      accountNumber: opened.reference, statusCode: "", statusDate: "00000000", lastPaymentDate: "00000000",
      monthsInArrears: "00", currentBalance: "000001000", openingBalance: "000001000", supplierNumber: "TT0109", transactionDate: "20260820",
    })
    const closure = records.find((r) => r.dataFlag === "C")!
    expect(closure).toMatchObject({
      accountNumber: settling.reference, statusCode: "T", statusDate: "20260820", currentBalance: "000000000",
      amountOverdue: "000000000", instalment: "000000000", lastPaymentDate: "20260820",
    })
    expect((await db.bureauSubmission.findUniqueOrThrow({ where: { id: dailyRun.submissionId } })).status).toBe("GENERATED")
    expect(await db.auditLog.count({ where: { tenantId: t.tenantId, action: "BUREAU_SUBMISSION_GENERATED", entityId: dailyRun.submissionId } })).toBe(1)


    // 1 Sep, 00:20 SAST: the monthly for August repeats the closure once.
    const august = await call(monthlyRoute, "", sast("2026-09-01", "00:20:00"))
    expect(august.status).toBe(200)
    expect(august.body).toMatchObject({ ok: true, kind: "MONTHLY", day: "2026-08-31" })
    const augustRun = generated(runFor(august.body, t))
    expect(augustRun.fileName).toBe("TT0109_ALL_T702_M_20260831_1_1")
    const augustLines = await fileLines(t, augustRun.submissionId)
    expect(augustLines).toHaveLength(4) // header, the closure, the open loan, trailer
    for (const line of augustLines) expect(line).toHaveLength(700)
    expect(augustLines[0].slice(0, 29)).toBe("H    TT0109202608310620260901")
    expect(augustLines[3].slice(0, 10)).toBe("T000000004")
    const augustRecords = augustLines.slice(1, 3).map((line) => parseRecord(line, "MONTHLY"))
    expect(augustRecords.every((r) => r.dataFlag === "D")).toBe(true)
    expect(augustRecords.find((r) => r.accountNumber === settling.reference)).toMatchObject({ statusCode: "T", statusDate: "20260820" })
    expect(augustRecords.find((r) => r.accountNumber === opened.reference)).toMatchObject({ statusCode: "", currentBalance: "000001000" })

    // 1 Oct: September's monthly no longer carries it.
    const september = await call(monthlyRoute, "", sast("2026-10-01", "00:20:00"))
    const septemberLines = await fileLines(t, generated(runFor(september.body, t)).submissionId)
    expect(septemberLines).toHaveLength(3)
    expect(parseRecord(septemberLines[1], "MONTHLY").accountNumber).toBe(opened.reference)
  })

  describe("in LIVE mode (the generator, as the scheduled job will call it once a transport exists)", () => {
    const live = async (t: BureauTenant, kind: "DAILY" | "MONTHLY", day: string, at: Date): Promise<GenerateResult> => {
      vi.setSystemTime(at)
      const args = { tenantId: t.tenantId, mode: "LIVE" as const, now: at, actor: { source: "cron" as const } }
      return runWithTenant(t.tenantId, () => kind === "DAILY"
        ? generateDaily(prisma, { ...args, day })
        : generateMonthly(prisma, { ...args, periodDay: day }))
    }
    const statuses = async (submissionId: string) =>
      (await db.bureauSubmissionRecord.findMany({ where: { submissionId, heldReason: null }, orderBy: { lineNo: "asc" } }))
        .map((r) => `${r.dataFlag}:${r.statusCode ?? "-"}`).sort()

    it("sends a registration and a closure once: a same-day re-run has nothing left, and the monthly repeats the closure once", async () => {
      const t = await createBureauTenant(db)
      const settling = await createBureauLoan(db, t, { startDay: "2026-07-01", dueDays: ["2026-08-01", "2026-09-01"] })
      await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
      vi.setSystemTime(sast("2026-08-20", "14:00:00"))
      await runWithTenant(t.tenantId, () => applyManualReceipt(prisma, {
        loanId: settling.loanId, tenantId: t.tenantId, amount: 2 * INSTALMENT, receivedAt: sast("2026-08-20", "14:00:00"), capturedById: t.userId,
      }))

      const daily = generated({ tenantId: t.tenantId, ...(await live(t, "DAILY", "2026-08-20", sast("2026-08-21", "00:20:00"))) })
      expect(daily.fileName).toBe("TT0109_ALL_L702_D_20260820_1_1")
      expect(await statuses(daily.submissionId)).toEqual(["C:T", "R:-"])
      // No file and no ledger row the second time.
      expect((await live(t, "DAILY", "2026-08-20", sast("2026-08-21", "06:00:00"))).outcome).toBe("NOTHING_TO_SEND")
      expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(1)

      const august = generated({ tenantId: t.tenantId, ...(await live(t, "MONTHLY", "2026-08-31", sast("2026-09-01", "00:20:00"))) })
      expect(await statuses(august.submissionId)).toEqual(["D:-", "D:T"])
      const september = generated({ tenantId: t.tenantId, ...(await live(t, "MONTHLY", "2026-09-30", sast("2026-10-01", "00:20:00"))) })
      expect(await statuses(september.submissionId)).toEqual(["D:-"])
    })

    it("holds a second closure of an account the bureau was already told closed", async () => {
      const t = await createBureauTenant(db)
      const loan = await createBureauLoan(db, t, { startDay: "2026-07-01", dueDays: ["2026-08-01", "2026-09-01"] })
      await db.loan.update({ where: { id: loan.loanId }, data: { status: "COMPLETED", closedAt: sast("2026-08-10"), totalPaid: 2 * INSTALMENT } })
      generated({ tenantId: t.tenantId, ...(await live(t, "DAILY", "2026-08-10", sast("2026-08-11", "00:20:00"))) })
      // Reopened by a reversal, then settled again four days later.
      await db.loan.update({ where: { id: loan.loanId }, data: { closedAt: sast("2026-08-14") } })
      const second = await live(t, "DAILY", "2026-08-14", sast("2026-08-15", "00:20:00"))
      expect(second).toMatchObject({ recordCount: 0, heldCount: 1, heldByReason: { REOPENED_AFTER_CLOSURE: 1 } })
    })

    it("registers a loan once when runs overlap: the index does not cover a registration, the sequence check does", async () => {
      const t = await createBureauTenant(db)
      const loan = await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
      const runs = await Promise.allSettled(Array.from({ length: 6 }, () => live(t, "DAILY", "2026-08-20", sast("2026-08-21", "00:20:00"))))
      for (const run of runs) {
        if (run.status === "rejected") expect(String(run.reason)).toMatch(/generated at the same time/)
        else expect(["GENERATED", "NOTHING_TO_SEND"]).toContain(run.value.outcome)
      }
      expect(await db.bureauSubmissionRecord.count({ where: { loanId: loan.loanId, mode: "LIVE", dataFlag: "R", heldReason: null } })).toBe(1)
      expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(1)
    })

    it("is refused by the scheduled routes while no push transport exists, writing nothing", async () => {
      const t = await createBureauTenant(db)
      await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
      process.env.BUREAU_SUBMISSION_MODE = "LIVE"
      try {
        for (const [route, query] of [[dailyRoute, "?date=2026-08-20"], [monthlyRoute, "?period=2026-08-31"]] as const) {
          const refused = await call(route, query, sast("2026-09-01", "00:20:00"))
          expect(refused.status).toBe(503)
          expect(refused.body).toMatchObject({ ok: false, mode: "LIVE", perTenant: [], error: "LIVE mode is refused while no push transport is configured" })
        }
      } finally {
        delete process.env.BUREAU_SUBMISSION_MODE
      }
      expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(0)
    })
  })

  it("holds a late re-run's registration when the loan has been paid since, rather than register today's balance", async () => {
    const t = await createBureauTenant(db)
    const loan = await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
    vi.setSystemTime(sast("2026-09-18"))
    await runWithTenant(t.tenantId, () => applyManualReceipt(prisma, {
      loanId: loan.loanId, tenantId: t.tenantId, amount: INSTALMENT, receivedAt: sast("2026-09-18"), capturedById: t.userId,
    }))
    const run = generated(runFor((await call(dailyRoute, "?date=2026-08-20", sast("2026-09-25"))).body, t))
    expect(run).toMatchObject({ recordCount: 0, heldCount: 1, heldByReason: { POST_PERIOD_ACTIVITY: 1 } })
  })

  it("holds a registration that fails validation, records it, and alerts staff through the bell", async () => {
    const t = await createBureauTenant(db, { role: "LOAN_ADMIN" })
    await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"], idNumber: invalidSaId() })
    const run = generated(runFor((await call(dailyRoute, "?date=2026-08-20", sast("2026-08-21", "00:20:00"))).body, t))
    expect(run).toMatchObject({ recordCount: 0, heldCount: 1, heldByReason: { INVALID_SA_ID: 1 } })
    const bell = await db.notification.findMany({ where: { tenantId: t.tenantId } })
    expect(bell).toHaveLength(1)
    expect(bell[0]).toMatchObject({ userId: t.userId, type: "BUREAU_HELD", entityType: "BureauSubmission", entityId: run.submissionId })
    // The alert names a count and a date, never a person.
    expect(`${bell[0].title} ${bell[0].body}`).not.toMatch(/Fixture|\d{13}/)
  })

  it("leaves out a loan opened or closed on another day", async () => {
    const t = await createBureauTenant(db)
    const loan = await createBureauLoan(db, t, { startDay: "2026-08-05", dueDays: ["2026-09-05", "2026-10-05"] })
    await db.loan.update({ where: { id: loan.loanId }, data: { status: "COMPLETED", closedAt: sast("2026-08-10"), totalPaid: 2 * INSTALMENT } })
    const run = runFor((await call(dailyRoute, "?date=2026-08-12", sast("2026-08-13", "00:20:00"))).body, t)
    expect(run.outcome).toBe("NOTHING_TO_SEND")
  })

  it("does not register a loan opened before the reporting start date", async () => {
    const t = await createBureauTenant(db)
    await createBureauLoan(db, t, { startDay: "2026-05-20", dueDays: ["2026-06-20", "2026-07-20"] })
    const run = runFor((await call(dailyRoute, "?date=2026-05-20", sast("2026-05-21", "00:20:00"))).body, t)
    expect(run.outcome).toBe("NOTHING_TO_SEND")
  })

  it("reports NOT_CONFIGURED and writes nothing without a supplier number", async () => {
    const t = await createBureauTenant(db, { bureauSupplierNumber: null })
    await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
    const daily = await call(dailyRoute, "?date=2026-08-20", sast("2026-08-21", "00:20:00"))
    expect(daily.status).toBe(200)
    expect(runFor(daily.body, t).outcome).toBe("NOT_CONFIGURED")
    const monthly = await call(monthlyRoute, "?period=2026-08-31", sast("2026-09-01", "00:20:00"))
    expect(runFor(monthly.body, t).outcome).toBe("NOT_CONFIGURED")
    expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(0)
  })

  it("does not read a tenant with the feature flag off", async () => {
    const t = await createBureauTenant(db, { featureBureauSubmission: false })
    await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
    const daily = await call(dailyRoute, "?date=2026-08-20", sast("2026-08-21", "00:20:00"))
    expect(daily.body.perTenant.some((run) => run.tenantId === t.tenantId)).toBe(false)
  })

  it("rejects a call without the cron secret before doing anything", async () => {
    const t = await createBureauTenant(db)
    await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
    for (const route of [dailyRoute, monthlyRoute]) {
      const denied = await call(route, "", sast("2026-09-01", "00:20:00"), "wrong-secret-of-same-len")
      expect(denied.status).toBe(401)
    }
    expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(0)
  })

  it("answers non-2xx when a tenant fails, and 400 for a malformed date", async () => {
    const t = await createBureauTenant(db)
    await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
    // A day that has not ended cannot be generated: the tenant fails, the run is 503.
    const early = await call(dailyRoute, "?date=2026-08-20", sast("2026-08-20", "12:00:00"))
    expect(early.status).toBe(503)
    expect(early.body.ok).toBe(false)
    expect(runFor(early.body, t)).toMatchObject({ outcome: "ERROR", error: "Bureau period 2026-08-20 has not ended" })
    const notMonthEnd = await call(monthlyRoute, "?period=2026-08-30", sast("2026-09-01", "00:20:00"))
    expect(notMonthEnd.status).toBe(503)

    expect((await call(dailyRoute, "?date=20260820", sast("2026-08-21"))).status).toBe(400)
    expect((await call(monthlyRoute, "?period=2026-02-30", sast("2026-09-01"))).status).toBe(400)
    expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(0)
  })
})
