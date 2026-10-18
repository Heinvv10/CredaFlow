/**
 * Real-Postgres proof of repricing beyond a monthly schedule: the notice
 * window (a row due tomorrow keeps its instalment), skip and seasonal
 * schedules stored with capitalised interest (repriced twice, the Loan totals,
 * contractual ones included, staying the schedule's sums), NCA cap-aware
 * repricing, the contract-type guard, and the cron sweep's selection (flag off, a
 * non-ACTIVE loan, a PENDING reference).
 *
 *   RUN_ASSET_FINANCE_REPRICE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/asset-finance/reprice-schedules.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { fromDayNumber, toDayNumber } from "./dates"
import { oracleDealFromInput, oracleReplay } from "./__tests__/structure-oracle"
import { noticeKeptThroughIndex, repriceTail } from "./reprice"
import { repriceLoanForReference } from "./reprice-loan"
import { runRepriceBatch } from "./reprice-batch"
import { toScheduleRecord } from "./schedule-records"
import { PATTERNS } from "./__tests__/schedule-fixtures"
import type { ScheduleRow, StructureResult } from "./types"
import {
  BOOKED, DEAL, PAID_ROWS, approvedPrime, bookedWith, pendingPrime, createRepriceLoan, createRepriceTenant, recordPrime, type RepriceTenant,
} from "./reprice.integration-fixture"

const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

const reprice = (tenant: RepriceTenant, loanId: string, effectiveDate: string, runDate = effectiveDate) =>
  prisma.$transaction((tx) => repriceLoanForReference(tx, { tenantId: tenant.tenantId, loanId, basis: "PRIME", effectiveDate, runDate }))
const scheduleOf = (loanId: string) => db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
const amounts = (r: { principalDue: number; interestDue: number; totalDue: number }) => [r.principalDue, r.interestDue, r.totalDue]
const dayBefore = (iso: string) => fromDayNumber(toDayNumber(iso) - 1)
const lastSettled = (booked: StructureResult) =>
  Math.max(...booked.rows.slice(0, PAID_ROWS).flatMap((row, i) => (row.totalCents > 0 ? [i] : [])))

/** The Loan totals are the schedule's sums after every write (schedule-records.ts INVARIANTS). */
async function expectLoanTotalsAreScheduleSums(loanId: string) {
  const rows = await scheduleOf(loanId)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId } })
  const sum = (pick: (r: (typeof rows)[number]) => number, only = (_r: (typeof rows)[number]) => true) =>
    rows.filter(only).reduce((total, r) => total + pick(r), 0)
  expect(loan.principal).toBe(sum((r) => r.principalDue))
  expect(loan.totalInterest).toBe(sum((r) => r.interestDue))
  expect(loan.totalRepayable).toBe(sum((r) => r.totalDue))
  // Booked equal (the fixture), and every repricing moves both by the same delta.
  expect([loan.contractualTotalInterest, loan.contractualTotalRepayable]).toEqual([loan.totalInterest, loan.totalRepayable])
  expect(loan.outstandingPrincipal).toBe(sum((r) => r.principalDue, (r) => r.status === "PENDING"))
  for (const r of rows) expect(Math.min(r.principalDue, r.interestDue, r.totalDue)).toBeGreaterThanOrEqual(0)
}

/** The independent expectation: the solver's own rows (true weights) re-solved at `ratePath`. */
function truthAfter(rows: ScheduleRow[], settled: number, _balance: number, ratePath: typeof DEAL.ratePath, runDate: string) {
  return repriceTail({
    rows, paidThroughIndex: settled, keptThroughIndex: noticeKeptThroughIndex(rows, settled, runDate), balanceAtRepriceCents: oracleReplay(oracleDealFromInput({ ...DEAL, ratePath }), rows.map((row) => row.totalCents - row.balloonCents))[settled].balanceAfterPaymentCents,
    repriceDate: rows[settled].dueDate, ratePath, balloonCents: DEAL.balloonCents,
  })
}

suite("repricing schedules against a migrated database", () => {
  let tenant: RepriceTenant
  let effectiveDate: string
  const secondDate = BOOKED.rows[PAID_ROWS + 1].dueDate // 2027-03-15
  beforeAll(async () => {
    tenant = await createRepriceTenant(db)
    effectiveDate = await recordPrime(db, tenant)
    await approvedPrime(db, tenant, secondDate, "0.115")
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it("a row due tomorrow keeps its instalment; the rows after it absorb the new rate's interest", async () => {
    const loanId = await createRepriceLoan(db, tenant)
    const tomorrowDue = BOOKED.rows[PAID_ROWS].dueDate // 2027-02-15
    const runDate = dayBefore(tomorrowDue)
    const before = await scheduleOf(loanId)
    expect(await reprice(tenant, loanId, effectiveDate, runDate)).toMatchObject({ kind: "repriced", rowsRepriced: 47 })
    const after = await scheduleOf(loanId)
    expect(after[PAID_ROWS].totalDue).toBe(before[PAID_ROWS].totalDue)
    expect(after[PAID_ROWS + 1].totalDue).toBeGreaterThan(before[PAID_ROWS + 1].totalDue)
    const ratePath = [...DEAL.ratePath, { effectiveDate, annualRate: 0.13 }]
    const expected = truthAfter(BOOKED.rows, PAID_ROWS - 1, BOOKED.rows[PAID_ROWS - 1].closingBalanceCents, ratePath, runDate)
    expect(after.slice(PAID_ROWS).map(amounts)).toEqual(expected.rows.map(toScheduleRecord).map(amounts))
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: loanId, action: "LOAN_REPRICED" } })
    expect(audit.newValue).toMatchObject({ runDate, rowsKeptForNotice: 1, firstRepricedInstallmentNo: PAID_ROWS + 2 })
    await expectLoanTotalsAreScheduleSums(loanId)
  })

  it.each(["BIANNUAL", "SEASONAL"])("%s: stored with capitalised interest, repriced twice, totals kept as the schedule's sums", async (name) => {
    const booked = bookedWith(PATTERNS[name])
    const loanId = await createRepriceLoan(db, tenant, { weights: PATTERNS[name] })
    const settled = lastSettled(booked)
    const stored = await scheduleOf(loanId)
    // Pending rows that pay no principal: skip rows, or rows whose payment is below their interest.
    expect(stored.filter((r) => r.status === "PENDING" && r.principalDue === 0).length).toBeGreaterThan(2)
    await expectLoanTotalsAreScheduleSums(loanId)

    const path1 = [...DEAL.ratePath, { effectiveDate, annualRate: 0.13 }]
    expect(await reprice(tenant, loanId, effectiveDate)).toMatchObject({ kind: "repriced" })
    const first = truthAfter(booked.rows, settled, booked.rows[settled].closingBalanceCents, path1, effectiveDate)
    expect((await scheduleOf(loanId)).slice(settled + 1).map(amounts)).toEqual(first.rows.map(toScheduleRecord).map(amounts))
    await expectLoanTotalsAreScheduleSums(loanId)

    // A second change two months on reads the repriced rows back from the database.
    expect(await reprice(tenant, loanId, secondDate)).toMatchObject({ kind: "repriced" })
    const merged = [...booked.rows.slice(0, settled + 1), ...first.rows]
    const second = truthAfter(merged, settled, booked.rows[settled].closingBalanceCents, [...path1, { effectiveDate: secondDate, annualRate: 0.125 }], secondDate)
    expect((await scheduleOf(loanId)).slice(settled + 1).map(amounts)).toEqual(second.rows.map(toScheduleRecord).map(amounts))
    await expectLoanTotalsAreScheduleSums(loanId)
  })

  it("reprices an NCA asset-finance loan within its cap and refuses a contract of type LOAN", async () => {
    const plain = await createRepriceLoan(db, tenant, { contractType: "LOAN", rate: null })
    expect(await reprice(tenant, plain, effectiveDate)).toEqual({ kind: "not_eligible", reason: "not_asset_finance" })
    const nca = await createRepriceLoan(db, tenant)
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      const loan = await tx.loan.update({ where: { id: nca }, data: { ncaRegime: "NCA" }, select: { applicationId: true } })
      await tx.loanApplication.update({ where: { id: loan.applicationId }, data: {
        ncaRegime: "NCA", ncaRepresentativeClientId: tenant.directorId, creditLifeElection: "DECLINED",
        creditLifeMonthlyPremiumCents: 0, creditLifeDisclosureVersion: "credit-life-no-offer-v1",
        creditLifeDisclosureSha256: "a".repeat(64), creditLifeDisclosureAcknowledgedAt: new Date(),
        creditLifeDisclosureAcknowledgedBy: tenant.directorId,
      } })
    })
    const repo = await db.referenceRate.create({
      data: { tenantId: tenant.tenantId, basis: "REPO", effectiveDate: new Date(`${DEAL.startDate}T00:00:00Z`), rate: "0.08", requestedById: tenant.adminId },
    })
    await db.referenceRate.update({ where: { id: repo.id }, data: { status: "APPROVED", decidedById: tenant.approverId, decidedAt: new Date() } })
    expect(await reprice(tenant, nca, effectiveDate)).toMatchObject({ kind: "repriced", resultingRate: "0.13" })
    expect(await db.contractRate.count({ where: { loanId: plain } })).toBe(0)
    expect(await db.contractRate.count({ where: { loanId: nca } })).toBe(2)
  })

  it("the sweep skips a tenant with the flag off, a loan that is not ACTIVE, and a PENDING reference", async () => {
    const off = await createRepriceTenant(db, false)
    const offLoan = await createRepriceLoan(db, off)
    const day = await recordPrime(db, off)
    const on = await createRepriceTenant(db)
    const defaulted = await createRepriceLoan(db, on)
    await db.loan.update({ where: { id: defaulted }, data: { status: "DEFAULTED" } })
    const active = await createRepriceLoan(db, on)
    // Recorded, never approved: the sweep must not reprice on it.
    await pendingPrime(db, on, day, "0.12")
    const untouched = await Promise.all([offLoan, defaulted, active].map(scheduleOf))

    const run = await runRepriceBatch(prisma, day)
    expect(run.perTenant.map((r) => r.tenantId)).not.toContain(off.tenantId)
    expect(run.perTenant.find((r) => r.tenantId === on.tenantId)).toEqual({ tenantId: on.tenantId, repriced: 0, alreadyRepriced: 0, notEligible: {}, failed: 0 })
    expect(await Promise.all([offLoan, defaulted, active].map(scheduleOf))).toEqual(untouched)
    expect(await db.contractRate.count({ where: { loanId: { in: [offLoan, defaulted, active] } } })).toBe(3)

    // Approved, the same value reprices the ACTIVE loan only.
    await db.referenceRate.updateMany({ where: { tenantId: on.tenantId, status: "PENDING" }, data: { status: "APPROVED", decidedById: on.approverId, decidedAt: new Date() } })
    const approvedRun = await runRepriceBatch(prisma, day)
    expect(approvedRun.perTenant.find((r) => r.tenantId === on.tenantId)).toMatchObject({ repriced: 1, failed: 0 })
    expect(await scheduleOf(defaulted)).toEqual(untouched[1])
    expect(await db.contractRate.count({ where: { loanId: active } })).toBe(2)
  })
})
