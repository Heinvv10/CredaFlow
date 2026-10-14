/**
 * Real-Postgres proof of asset-finance repricing (goal 4.4): the PENDING rows
 * of a part-paid NON_NCA instalment sale are re-solved in place on a prime
 * change (the PASQ v3 schedule guards and every other live trigger run), the
 * balance still lands on the balloon, and the run is idempotent, alone, again
 * and concurrently.
 *
 *   RUN_ASSET_FINANCE_REPRICE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/asset-finance/reprice-loan.integration.test.ts
 */
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { currentSettlementAmount, projectReceipt } from "@/lib/loan/settlement"
import { repriceTail } from "./reprice"
import { repriceLoanForReference, type RepriceOutcome } from "./reprice-loan"
import { runRepriceBatch } from "./reprice-batch"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { toScheduleRecord } from "./schedule-records"
import { expectRowIdentities } from "./__tests__/oracle-assertions"
import { oracleDealFromInput, oracleReplay } from "./__tests__/structure-oracle"
import {
  BOOKED, DEAL, PAID_ROWS, createRepriceLoan, createRepriceTenant, recordPrime, type RepriceTenant,
} from "./reprice.integration-fixture"

const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

const reprice = (tenant: RepriceTenant, loanId: string, effectiveDate: string): Promise<RepriceOutcome> =>
  prisma.$transaction((tx) => repriceLoanForReference(tx, { tenantId: tenant.tenantId, loanId, basis: "PRIME", effectiveDate, runDate: effectiveDate }))

const scheduleOf = (loanId: string) => db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
const loanOf = (loanId: string) => db.loan.findUniqueOrThrow({ where: { id: loanId } })
const repricedAudits = (tenantId: string, loanId: string) =>
  db.auditLog.findMany({ where: { tenantId, entityId: loanId, action: AuditAction.LOAN_REPRICED } })

// The expected tail, derived independently of the stored rows: the solver's
// own schedule re-solved from the last paid due date at 12.00% + 1% from E.
function expectedTail(effectiveDate: string) {
  const ratePath = [...DEAL.ratePath, { effectiveDate, annualRate: 0.13 }]
  const solved = repriceTail({
    rows: BOOKED.rows,
    paidThroughIndex: PAID_ROWS - 1,
    balanceAtRepriceCents: BOOKED.rows[PAID_ROWS - 1].closingBalanceCents,
    repriceDate: BOOKED.rows[PAID_ROWS - 1].dueDate,
    ratePath,
    balloonCents: DEAL.balloonCents,
  })
  return { ...solved, ratePath }
}

suite("repriceLoanForReference against a migrated database", () => {
  let tenant: RepriceTenant
  let loanId: string
  let effectiveDate: string
  let first: RepriceOutcome

  beforeAll(async () => {
    tenant = await createRepriceTenant(db)
    loanId = await createRepriceLoan(db, tenant)
    effectiveDate = await recordPrime(db, tenant)
    first = await reprice(tenant, loanId, effectiveDate)
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it("re-solves the PENDING rows in place and leaves the paid rows alone", async () => {
    const expected = expectedTail(effectiveDate)
    expect(first).toMatchObject({ kind: "repriced", resultingRate: "0.13", newInstalmentCents: expected.baseInstalmentCents, rowsRepriced: 48 })
    expect(expected.baseInstalmentCents).toBeGreaterThan(BOOKED.baseInstalmentCents)

    const rows = await scheduleOf(loanId)
    expect(rows).toHaveLength(60)
    const amounts = (r: { installmentNo: number; dueDate: Date; principalDue: number; interestDue: number; feesDue: number; creditLifePremiumDue: number; totalDue: number }) =>
      ({ installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, creditLifePremiumDue: r.creditLifePremiumDue, totalDue: r.totalDue })
    expect(rows.slice(0, PAID_ROWS).map(amounts)).toEqual(BOOKED.rows.slice(0, PAID_ROWS).map(toScheduleRecord))
    expect(rows.slice(PAID_ROWS).map(amounts)).toEqual(expected.rows.map(toScheduleRecord))
    expect(rows.slice(PAID_ROWS).every((r) => r.status === "PENDING" && r.totalPaid === 0)).toBe(true)
  })

  it("keeps the balloon as its own final payment, and the oracle's day walk agrees on every row's interest", async () => {
    const expected = expectedTail(effectiveDate)
    expectRowIdentities(expected.rows, BOOKED.rows[PAID_ROWS - 1].closingBalanceCents, DEAL.balloonCents)
    const rows = await scheduleOf(loanId)
    const regular = rows.map((r, i) => r.totalDue - (i === rows.length - 1 ? DEAL.balloonCents : 0))
    // E is row 12's own due date, a day the paid row 12 already charged at the
    // old rate; repricing never reopens a settled row, so over the whole
    // contract the new rate runs from the day after.
    const wholeContractPath = [...DEAL.ratePath, { effectiveDate: "2027-01-16", annualRate: 0.13 }]
    expect(effectiveDate).toBe("2027-01-15")
    const replay = oracleReplay(oracleDealFromInput({ ...DEAL, ratePath: wholeContractPath }), regular)
    expect(replay.map((r) => r.interestCents)).toEqual(rows.map((r) => r.interestDue))
    expect(replay[replay.length - 1].balanceAfterPaymentCents).toBe(DEAL.balloonCents)
    // The last regular instalment is an ordinary one (it only absorbs the
    // rounding residue): the balloon was not folded into the re-solve.
    const pendingRegular = regular.slice(PAID_ROWS)
    expect(new Set(pendingRegular.slice(0, -1))).toEqual(new Set([expected.baseInstalmentCents]))
    expect(Math.abs(pendingRegular[pendingRegular.length - 1] - expected.baseInstalmentCents)).toBeLessThanOrEqual(60)
  })

  it("records the contract rate, the loan totals, the audit row and the staff notice in the same commit", async () => {
    const rates = await db.contractRate.findMany({ where: { loanId }, orderBy: { effectiveDate: "asc" } })
    expect(rates).toHaveLength(2)
    expect(rates[1]).toMatchObject({ basis: "PRIME", fixedRate: null, newInstalmentCents: expectedTail(effectiveDate).baseInstalmentCents })
    expect([rates[1].margin?.toString(), rates[1].resultingRate.toString()]).toEqual(["0.01", "0.13"])

    const rows = await scheduleOf(loanId)
    const loan = await loanOf(loanId)
    expect(loan.principal).toBe(rows.reduce((sum, r) => sum + r.principalDue, 0))
    expect(loan.totalRepayable).toBe(rows.reduce((sum, r) => sum + r.totalDue, 0))
    expect(loan.totalInterest).toBe(rows.reduce((sum, r) => sum + r.interestDue, 0))
    expect(loan.interestRatePm).toBeCloseTo(0.13 / 12, 12)

    const audits = await repricedAudits(tenant.tenantId, loanId)
    expect(audits).toHaveLength(1)
    expect(audits[0].oldValue).toMatchObject({ resultingRate: "0.1275", baseInstalmentCents: BOOKED.baseInstalmentCents })
    expect(audits[0].newValue).toMatchObject({
      effectiveDate, referenceRate: "0.12", margin: "0.01", resultingRate: "0.13", rowsRepriced: 48,
      firstRepricedInstallmentNo: PAID_ROWS + 1, noticeRecipientClientIds: [tenant.directorId], noticeSent: false,
    })
    const bell = await db.notification.findMany({ where: { tenantId: tenant.tenantId, entityId: loanId } })
    expect(bell.map((n) => [n.userId, n.type])).toEqual([[tenant.adminId, "LOAN_REPRICED"]])
  })

  it("a repriced loan settles on the repriced schedule: the contractual totals moved with it", async () => {
    const rows = await scheduleOf(loanId)
    const loan = await loanOf(loanId)
    const booked = BOOKED.rows.map(toScheduleRecord)
    // The fixture booked contractual = schedule sums; the repricing moved both by the same delta.
    expect(loan.contractualTotalRepayable).toBe(loan.totalRepayable)
    expect(loan.contractualTotalInterest).toBe(loan.totalInterest)
    expect(loan.contractualTotalRepayable).not.toBe(booked.reduce((sum, r) => sum + r.totalDue, 0))
    const owedOnSchedule = rows.reduce((sum, r) => sum + r.totalDue - r.totalPaid, 0)
    expect(currentSettlementAmount({ loan, schedule: rows, asOf: new Date() })).toBe(owedOnSchedule)
    const settling = projectReceipt({ loan, schedule: rows, amount: owedOnSchedule, asOf: new Date() })
    expect(settling).toMatchObject({ settlementDue: owedOnSchedule, isCompleted: true, excessAmount: 0 })
  })

  it("is a no-op the second time: already_repriced, and every row byte-identical", async () => {
    const before = { rows: await scheduleOf(loanId), loan: await loanOf(loanId) }
    expect(await reprice(tenant, loanId, effectiveDate)).toEqual({ kind: "already_repriced" })
    expect(await scheduleOf(loanId)).toEqual(before.rows)
    expect(await loanOf(loanId)).toEqual(before.loan)
    expect(await db.contractRate.count({ where: { loanId } })).toBe(2)
    expect(await repricedAudits(tenant.tenantId, loanId)).toHaveLength(1)
  })

  it("lets exactly one of two concurrent runs reprice", async () => {
    const racing = await createRepriceLoan(db, tenant)
    const outcomes = await Promise.all([reprice(tenant, racing, effectiveDate), reprice(tenant, racing, effectiveDate)])
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["already_repriced", "repriced"])
    expect(await db.contractRate.count({ where: { loanId: racing, effectiveDate: dbDate(effectiveDate) } })).toBe(1)
    expect(await repricedAudits(tenant.tenantId, racing)).toHaveLength(1)
    const rows = await scheduleOf(racing)
    expect(rows.slice(PAID_ROWS).map((r) => r.totalDue)).toEqual(expectedTail(effectiveDate).rows.map((r) => r.totalCents))
  })

  it("names the first payment after the notice window as the changed payment", async () => {
    const noticeLoan = await createRepriceLoan(db, tenant)
    const firstPendingDue = BOOKED.rows[PAID_ROWS].dueDate
    const runDate = fromDayNumber(toDayNumber(firstPendingDue) - 1)
    const outcome = await prisma.$transaction((tx) => repriceLoanForReference(tx, {
      tenantId: tenant.tenantId,
      loanId: noticeLoan,
      basis: "PRIME",
      effectiveDate,
      runDate,
    }))
    expect(outcome.kind).toBe("repriced")

    const bell = await db.notification.findFirstOrThrow({
      where: { tenantId: tenant.tenantId, entityId: noticeLoan, type: "LOAN_REPRICED" },
    })
    expect(bell.body).toContain(`From the payment due ${BOOKED.rows[PAID_ROWS + 1].dueDate}`)
    expect(bell.body).not.toContain(`From the payment due ${firstPendingDue}`)
  })

  it("the cron sweep reprices a linked loan once, skips a fixed-rate one, and re-running changes nothing", async () => {
    const other = await createRepriceTenant(db)
    const linked = await createRepriceLoan(db, other)
    const fixed = await createRepriceLoan(db, other, { rate: { basis: "FIXED", fixedRate: "0.14" } })
    const day = await recordPrime(db, other)

    const firstRun = (await runRepriceBatch(prisma, day)).perTenant.find((r) => r.tenantId === other.tenantId)
    expect(firstRun).toEqual({ tenantId: other.tenantId, repriced: 1, alreadyRepriced: 0, notEligible: {}, failed: 0 })
    const fixedBefore = { rows: await scheduleOf(fixed), loan: await loanOf(fixed) }
    const linkedBefore = await scheduleOf(linked)

    const secondRun = (await runRepriceBatch(prisma, day)).perTenant.find((r) => r.tenantId === other.tenantId)
    expect(secondRun).toEqual({ tenantId: other.tenantId, repriced: 0, alreadyRepriced: 0, notEligible: {}, failed: 0 })
    expect(await scheduleOf(linked)).toEqual(linkedBefore)
    expect(await scheduleOf(fixed)).toEqual(fixedBefore.rows)
    expect(await loanOf(fixed)).toEqual(fixedBefore.loan)
    expect(await db.contractRate.count({ where: { loanId: fixed } })).toBe(1)
  })

  it("refuses a contract rate that is neither fixed nor reference + margin (CHECK)", async () => {
    // Each with trigger ContractRate_guard off, rolled back: its basis-and-margin
    // continuity rule would otherwise refuse every one of these rows first.
    const unguarded = (data: Prisma.ContractRateUncheckedCreateInput) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "ContractRate" DISABLE TRIGGER "ContractRate_guard"')
      await tx.contractRate.create({ data })
      throw new Error("ROLLBACK")
    })
    const row = { tenantId: tenant.tenantId, loanId, effectiveDate: dbDate("2027-06-01"), basis: "PRIME" as const }
    await expect(unguarded({ ...row, resultingRate: "0.13" })).rejects.toThrow(/ContractRate_fixed_xor_margin/)
    await expect(unguarded({ ...row, fixedRate: "0.13", resultingRate: "0.13" })).rejects.toThrow(/ContractRate_fixed_basis/)
    await expect(unguarded({ ...row, margin: "1.38", resultingRate: "1.5" })).rejects.toThrow(/ContractRate_resulting_rate_range/)
  })
})
