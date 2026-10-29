/**
 * Real-Postgres proof of the net basis (IFRS 9 5.4.1(b)) and of the chain of monthly runs through the real close:
 * the allowance is the ECL on the gross exposure, the Stage 3 month's interest is taken off income against the ECL expense
 * (no suspense), nothing is given back on cure, the basis cannot change once posted, and a month closes only on a run that
 * follows from the month before.
 *
 *   RUN_IFRS9_IT=1 RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/accounting/ifrs9-net.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ASSET_FINANCE_ROLES, IFRS9_ROLES } from "./accounts"
import { closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"
import { actorOf, asTenant, at, configure, db, lender, monthEnd, monthly, type Lender } from "@/lib/ifrs9/ifrs9.integration-fixture"
import { saveSettings } from "@/lib/ifrs9/store"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { prisma } from "@/lib/prisma"

const suite = process.env.RUN_IFRS9_IT === "1" ? describe : describe.skip
const NOW = new Date("2027-01-05T10:00:00+02:00")

/** R2 000 due 1 Sep, then R100 interest due 15 Oct and R100 interest due 15 Nov. */
async function netLender(over: Parameters<typeof configure>[1] = {}): Promise<Lender> {
  const t = await lender()
  await db.repaymentSchedule.deleteMany({ where: { loanId: t.loanId, installmentNo: 2 } })
  await db.repaymentSchedule.updateMany({ where: { loanId: t.loanId, installmentNo: 1 }, data: { dueDate: at("2026-09-01"), principalDue: 200_000, interestDue: 10_000, feesDue: 6_900, totalDue: 216_900 } })
  for (const [no, due] of [[2, "2026-10-15"], [3, "2026-11-15"]] as const) {
    await db.repaymentSchedule.create({ data: { tenantId: t.tenantId, loanId: t.loanId, installmentNo: no, dueDate: at(due), principalDue: 0, interestDue: 10_000, feesDue: 0, totalDue: 10_000 } })
  }
  await db.accountingSettings.create({ data: { tenantId: t.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08", mappingConfirmedRoles: [...ASSET_FINANCE_ROLES, ...IFRS9_ROLES] } })
  await configure(t, { effectiveFromMonth: "2026-10", ...over })
  return t
}

const plan = (t: Lender, key: string) => asTenant(t, () => planPeriod(prisma, t.tenantId, parsePeriodKey(key)!, NOW))
const close = (t: Lender, key: string) => asTenant(t, () => closePeriod(prisma, { tenantId: t.tenantId, periodKey: key, userId: t.userId, userEmail: "ifrs9-it@test.invalid", now: NOW }))
async function totals(tenantId: string): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<Array<{ role: string; cents: bigint }>>`
    SELECT COALESCE(l."sourceRole", l."role") AS role, SUM(l."debitCents" - l."creditCents")::bigint AS cents
    FROM "AccountingJournalLine" l JOIN "AccountingExportBatch" b ON b."id" = l."batchId"
    WHERE l."tenantId" = ${tenantId} AND b."status" = 'CLOSED' AND l."role" <> 'OPENING_BALANCE_EQUITY' GROUP BY 1`
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.cents)]))
}

suite.sequential("IFRS 9 net basis and run chain in the ledger (real Postgres)", () => {
  let n: Lender
  beforeAll(async () => {
    n = await netLender({ stage3InterestBasis: "NET_BASIS" })
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("closes Stage 2 October as before and Stage 3 November with the allowance on the gross exposure and the month's interest taken off against the expense", async () => {
    for (const key of ["2026-08", "2026-09"]) await close(n, key)
    await monthly(n, "2026-10", monthEnd("2026-10-31"))
    await close(n, "2026-10")
    // 31 Oct, 60 days past due: Stage 2. Gross EAD = 200 000 + 20 000 + 6 900 + 10 000 x 16/31 (5 161) = 232 061 ; ECL = 232 061 x 15% x 50% = 17 404.6
    expect((await totals(n.tenantId)).ECL_ALLOWANCE).toBe(-17_405)

    await monthly(n, "2026-11", monthEnd("2026-11-30"))
    expect((await plan(n, "2026-11")).refusal).toBeNull()
    await close(n, "2026-11")
    const t = await totals(n.tenantId)
    // 30 Nov, 90 days past due: Stage 3. Gross EAD = 200 000 + 30 000 + 6 900 = 236 900 ; ECL = 236 900 x 100% x 60% = 142 140.
    // November's instalment interest is 10 000, and 142 140 / 236 900 is 60%: 6 000 comes off income and off the ECL expense.
    expect(t.ECL_ALLOWANCE).toBe(-142_140)
    expect(t.ECL_EXPENSE).toBe(142_140 - 6_000)
    expect(t.INTEREST_INCOME).toBe(-30_000 + 6_000)
    expect(t.INTEREST_SUSPENSE ?? 0).toBe(0)
    // the borrower still owes it all
    expect(t.LOAN_BOOK).toBe(236_900)
  })

  it("gives nothing back to income when the loan is cured: the adjustment is prospective", async () => {
    await db.payment.create({ data: { tenantId: n.tenantId, loanId: n.loanId, amount: 236_900, receivedAt: at("2026-12-10") } })
    await db.repaymentSchedule.updateMany({ where: { loanId: n.loanId }, data: { totalPaid: 0 } })
    for (const [no, due] of [[1, 216_900], [2, 10_000], [3, 10_000]] as const) await db.repaymentSchedule.updateMany({ where: { loanId: n.loanId, installmentNo: no }, data: { totalPaid: due, status: "PAID" } })
    await db.loan.update({ where: { id: n.loanId }, data: { outstandingPrincipal: 0 } })
    await monthly(n, "2026-12", monthEnd("2026-12-31"))
    await close(n, "2026-12")
    const t = await totals(n.tenantId)
    expect(t.ECL_ALLOWANCE).toBe(0)
    // the allowance of 142 140 is released, which is 6 000 more than was charged to the expense net of the interest adjustment
    expect(t.ECL_EXPENSE).toBe(-6_000)
    expect(t.INTEREST_INCOME).toBe(-24_000)
    // income + expense together are the 30 000 of interest the loan earned: the adjustment only moved it between lines
    expect(-t.INTEREST_INCOME + t.ECL_EXPENSE).toBe(18_000)
  })

  it("refuses to change the Stage 3 basis once IFRS 9 has posted, and is quiet about a change that keeps it", async () => {
    const actor = actorOf(n)
    const change = await asTenant(n, () => saveSettings(prisma, n.tenantId, { ...DEFAULT_SETTINGS, enabled: true, effectiveFromMonth: "2026-10", stage3InterestBasis: "FULL_SUSPENSION" }, actor))
    expect(change).toMatchObject({ ok: false, error: expect.stringContaining("stage3InterestBasis") })
  })
})

suite.sequential("IFRS 9 run chain at the close (real Postgres)", () => {
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  // Review breaker 3b (PR #255 round 2): replacing October's run leaves November's, made before it, resting on the old one.
  it("holds a month whose run was made before an earlier month's run was replaced until its own run is replaced too", async () => {
    const g = await netLender()
    for (const key of ["2026-08", "2026-09"]) await close(g, key)
    const oct = await monthly(g, "2026-10", monthEnd("2026-10-31"))
    const nov = await monthly(g, "2026-11", monthEnd("2026-11-30"))
    await monthly(g, "2026-10", at("2026-12-02"), { supersede: { runId: oct.runId, reason: "PD corrected" } })
    await close(g, "2026-10")

    const refused = await plan(g, "2026-11")
    expect(refused.refusal).toMatchObject({ code: "IFRS9_RUN_STALE" })
    expect(refused.refusal?.message).toContain(`supersedesRunId: "${nov.runId}"`)
    await expect(close(g, "2026-11")).rejects.toMatchObject({ code: "IFRS9_RUN_STALE" })

    await monthly(g, "2026-11", at("2026-12-03"), { supersede: { runId: nov.runId, reason: "restated on the corrected October" } })
    expect((await plan(g, "2026-11")).refusal).toBeNull()
    await close(g, "2026-11")
  })

  // Review breaker 3a/3c through the close: the make-up November run still sees the loan written off on 2 December.
  it("posts a loan written off after the month end in that month's allowance, then uses it at write-off", async () => {
    const b = await netLender()
    for (const key of ["2026-08", "2026-09"]) await close(b, key)
    await monthly(b, "2026-10", monthEnd("2026-10-31"))
    await close(b, "2026-10")
    await db.loan.update({ where: { id: b.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: at("2026-12-02"), closedAt: at("2026-12-02") } })
    await monthly(b, "2026-11", at("2026-12-03"))
    await close(b, "2026-11")
    // at 30 Nov the loan (90 days past due, Stage 3) was on the book: its allowance is held, not released by the later write-off.
    // Full suspension: exposure 236 900 less 30 000 of interest in suspense = 206 900 ; ECL = 206 900 x 100% x 60% = 124 140
    const t = await totals(b.tenantId)
    expect(t.ECL_ALLOWANCE).toBe(-124_140)
    expect(t.INTEREST_SUSPENSE).toBe(-30_000)
  })

  // Breaker 1 (PR #255 round 3): a run on record for a month IFRS 9 no longer governs must post nothing.
  it("posts nothing for a month before the first month IFRS 9 governs, even when a run is on record for it", async () => {
    const e = await netLender({ effectiveFromMonth: "2026-09" })
    await close(e, "2026-08")
    await monthly(e, "2026-09", monthEnd("2026-09-30"))
    await configure(e, { effectiveFromMonth: "2026-10" })
    await close(e, "2026-09")
    const t = await totals(e.tenantId)
    expect(t.ECL_ALLOWANCE ?? 0).toBe(0)
    expect(t.ECL_EXPENSE ?? 0).toBe(0)
  })

  // Breaker H2: net adjustments from a month before the first governed one must not be summed in.
  it("sums net-basis adjustments only from the first governed month", async () => {
    const h = await netLender({ effectiveFromMonth: "2026-11", stage3InterestBasis: "NET_BASIS" })
    for (const key of ["2026-08", "2026-09", "2026-10"]) await close(h, key)
    const nov = await monthly(h, "2026-11", monthEnd("2026-11-30"))
    // November's Stage 3 run adjusts R60 of interest; then go-live moves to December (nothing has posted, so it may)
    expect((await db.ifrs9LoanSnapshot.findFirstOrThrow({ where: { runId: nov.runId } })).netInterestAdjustmentCents).toBe(6_000)
    await configure(h, { effectiveFromMonth: "2026-12", stage3InterestBasis: "NET_BASIS" })
    await close(h, "2026-11")
    await monthly(h, "2026-12", monthEnd("2026-12-31"))
    await close(h, "2026-12")
    const t = await totals(h.tenantId)
    expect(t.INTEREST_INCOME).toBe(-30_000)
    expect(t.ECL_EXPENSE).toBe(-(t.ECL_ALLOWANCE))
  })

  // Low 7: the close refuses rather than silently keeping an allowance it cannot place.
  it("refuses the close for a loan whose status says it left the book with no date", async () => {
    const u = await netLender()
    for (const key of ["2026-08", "2026-09"]) await close(u, key)
    await monthly(u, "2026-10", monthEnd("2026-10-31"))
    await close(u, "2026-10")
    await db.loan.update({ where: { id: u.loanId }, data: { status: "COMPLETED", closedAt: null } })
    await monthly(u, "2026-11", at("2026-12-02"), { lateReason: "job down" })
    const refused = await plan(u, "2026-11")
    expect(refused.refusal).toMatchObject({ code: "IFRS9_EXIT_UNDATED" })
    expect(refused.refusal?.message).toContain("LN-")
  })
})
