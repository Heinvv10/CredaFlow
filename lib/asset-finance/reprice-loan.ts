/**
 * Reprices one reference-linked asset-finance loan when its reference rate
 * moves (DESIGN.md D4: term and balloon unchanged). Runs inside the caller's
 * transaction; every write below commits or rolls back together.
 *
 * ELIGIBLE: an ACTIVE, NON_NCA loan whose contractType is not LOAN, and whose
 * latest ContractRate before `effectiveDate` is `basis` + a margin.
 *
 * IDEMPOTENT per (loan, effectiveDate). The loan row is locked first
 * (lockLoanForUpdate, which also serialises receipts), so a concurrent second
 * run waits and then finds the first run's ContractRate row: already_repriced,
 * nothing changed. The unique index on ContractRate(loanId, effectiveDate) is
 * the backstop: the ContractRate insert is the FIRST write, and its P2002 is
 * answered the same way before anything else is written. Postgres has then
 * aborted the transaction, so the caller's commit becomes a rollback, which is
 * exactly "nothing changed".
 *
 * THE RE-SOLVE. The new contract rate is reference + margin from
 * `effectiveDate`. The pending rows are re-solved by repriceTail with:
 *   - repriceDate = the last settled row's due date (the loan's start date
 *     when none is settled), and balanceAtReprice = the capital those pending
 *     rows still amortise (Σ pending principalDue, ./schedule-records.ts);
 *   - ratePath = the contract history before effectiveDate plus the new point.
 *   The period that straddles effectiveDate is therefore charged the old rate
 *   up to the day before and the new rate from it, as simple interest on the
 *   period's opening balance: the solver's own rule, no interest capitalised.
 *   An effectiveDate on or before the last settled due date reprices only
 *   the pending periods; settled rows are history and are never adjusted.
 *   Due dates and weights are kept (weights derived as in
 *   ./schedule-records.ts); the balloon is Loan.balloonAmount (0 when null).
 *
 * WRITES: the ContractRate row (with the new base instalment), each pending
 * RepaymentSchedule row in place (pinned to PENDING, nothing paid), the loan's
 * totalInterest/totalRepayable by the change in the pending rows' totals
 * (capital is unchanged, so the whole change is interest; the contractual*
 * baseline is left alone), Loan.interestRatePm = resultingRate / 12 (the loan
 * page, statement and book export show it), the LOAN_REPRICED audit row and
 * the new-instalment notice (./reprice-notice.ts). The deferred constraint
 * triggers are forced before returning, so "repriced" means it will commit.
 *
 * // PARTIAL: a pending VAT-deferral lump is NOT detected. Goal 4.4 asks for a
 * `vat_deferral_pending` refusal, but no table records a deal's VAT deferral
 * yet (DealStructure is planned, not built), and the lump is invisible in the
 * schedule rows: it would read as a heavy weight and be scaled with the new
 * instalment. Until booking persists the structure, do not book a VAT-deferral
 * deal on a reference-linked rate.
 *
 * // PARTIAL: NCA asset-finance contracts are refused (D4 re-checks the NCA
 * rate cap on every repricing; slice 1 books NON_NCA deals only).
 */
import { Prisma, type ReferenceRateBasis } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { sastCalendarDate } from "@/lib/date/sast"
import { toDayNumber } from "./dates"
import { contractRatePath, dbDate, isoOfDbDate, referenceRateOn } from "./rates-store"
import { repriceTail } from "./reprice"
import { queueRepriceNotice } from "./reprice-notice"
import { storedScheduleForReprice, type StoredScheduleError } from "./schedule-records"

export type RepriceTx = Pick<
  typeof prisma,
  "$queryRaw" | "$executeRawUnsafe" | "loan" | "repaymentSchedule" | "contractRate" | "referenceRate" | "auditLog" | "entityRelationship" | "user" | "notification"
>

export interface RepriceRequest {
  tenantId: string
  loanId: string
  basis: ReferenceRateBasis
  effectiveDate: string // YYYY-MM-DD
  actorUserId?: string
}

export type NotEligibleReason =
  | "loan_not_found"
  | "not_active"
  | "not_asset_finance"
  | "nca_regime"
  | "no_reference_rate"
  | "not_linked_to_basis"
  | "superseded" // the loan already has a contract rate from a later date
  | StoredScheduleError

export type RepriceOutcome =
  | {
      kind: "repriced"
      contractRateId: string
      resultingRate: string
      oldInstalmentCents: number
      newInstalmentCents: number
      rowsRepriced: number
      noticeRecipientClientIds: string[]
    }
  | { kind: "already_repriced" }
  | { kind: "not_eligible"; reason: NotEligibleReason }

const notEligible = (reason: NotEligibleReason): RepriceOutcome => ({ kind: "not_eligible", reason })

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

export async function repriceLoanForReference(tx: RepriceTx, request: RepriceRequest): Promise<RepriceOutcome> {
  const { tenantId, loanId, basis, effectiveDate } = request
  toDayNumber(effectiveDate, "effectiveDate")
  await lockLoanForUpdate(tx, loanId)

  const loan = await tx.loan.findFirst({
    where: { id: loanId, tenantId },
    select: {
      id: true, reference: true, status: true, contractType: true, ncaRegime: true,
      entityId: true, balloonAmount: true, startDate: true, interestRatePm: true,
    },
  })
  if (!loan) return notEligible("loan_not_found")
  const existing = await tx.contractRate.findUnique({
    where: { loanId_effectiveDate: { loanId, effectiveDate: dbDate(effectiveDate) } },
    select: { id: true },
  })
  if (existing) return { kind: "already_repriced" }

  if (loan.status !== "ACTIVE") return notEligible("not_active")
  if (loan.contractType === "LOAN") return notEligible("not_asset_finance")
  if (loan.ncaRegime !== "NON_NCA") return notEligible("nca_regime")

  const later = await tx.contractRate.findFirst({ where: { loanId, effectiveDate: { gt: dbDate(effectiveDate) } }, select: { id: true } })
  if (later) return notEligible("superseded")
  const prior = await tx.contractRate.findFirst({
    where: { loanId, effectiveDate: { lt: dbDate(effectiveDate) } },
    orderBy: { effectiveDate: "desc" },
    select: { basis: true, margin: true, resultingRate: true, effectiveDate: true },
  })
  if (!prior || prior.basis !== basis || prior.margin === null) return notEligible("not_linked_to_basis")
  const reference = await referenceRateOn(tx, tenantId, basis, effectiveDate)
  if (!reference) return notEligible("no_reference_rate")
  const resultingRate = reference.rate.add(prior.margin)

  const recordedBase = await tx.contractRate.findFirst({
    where: { loanId, effectiveDate: { lt: dbDate(effectiveDate) }, newInstalmentCents: { not: null } },
    orderBy: { effectiveDate: "desc" },
    select: { newInstalmentCents: true },
  })
  const stored = await tx.repaymentSchedule.findMany({
    where: { loanId, tenantId },
    orderBy: { installmentNo: "asc" },
    select: {
      id: true, installmentNo: true, dueDate: true, principalDue: true, interestDue: true, feesDue: true,
      creditLifePremiumDue: true, totalDue: true, totalPaid: true, status: true,
    },
  })
  const balloonCents = loan.balloonAmount ?? 0
  const schedule = storedScheduleForReprice(stored, balloonCents, recordedBase?.newInstalmentCents ?? null)
  if ("error" in schedule) return notEligible(schedule.error)

  const paid = schedule.paidThroughIndex
  const history = (await contractRatePath(tx, loanId)).filter((point) => point.effectiveDate < effectiveDate)
  const solved = repriceTail({
    rows: schedule.rows,
    paidThroughIndex: paid,
    balanceAtRepriceCents: schedule.capitalOutstandingCents,
    repriceDate: paid >= 0 ? schedule.rows[paid].dueDate : sastCalendarDate(loan.startDate),
    ratePath: [...history, { effectiveDate, annualRate: resultingRate.toNumber() }],
    balloonCents,
  })

  // The first write: on a lost race the unique index refuses it before
  // anything else has changed.
  let contractRateId: string
  try {
    const created = await tx.contractRate.create({
      data: {
        tenantId, loanId, effectiveDate: dbDate(effectiveDate), basis, margin: prior.margin,
        resultingRate, newInstalmentCents: solved.baseInstalmentCents, createdById: request.actorUserId ?? null,
      },
      select: { id: true },
    })
    contractRateId = created.id
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "already_repriced" }
    throw error
  }

  let totalChange = 0
  for (const row of solved.rows) {
    const before = stored[row.index]
    const updated = await tx.repaymentSchedule.updateMany({
      where: { id: before.id, tenantId, loanId, status: "PENDING", totalPaid: 0 },
      data: { principalDue: row.principalCents + row.balloonCents, interestDue: row.interestCents, totalDue: row.totalCents },
    })
    if (updated.count !== 1) throw new Error(`reprice: schedule row ${before.installmentNo} of loan ${loanId} changed underneath the repricing`)
    totalChange += row.totalCents - before.totalDue
  }
  const loanUpdated = await tx.loan.updateMany({
    where: { id: loanId, tenantId, status: "ACTIVE" },
    data: {
      totalInterest: { increment: totalChange },
      totalRepayable: { increment: totalChange },
      interestRatePm: resultingRate.div(12).toNumber(),
    },
  })
  if (loanUpdated.count !== 1) throw new Error(`reprice: loan ${loanId} changed underneath the repricing`)

  const noticeRecipientClientIds = await queueRepriceNotice(tx, {
    tenantId, loanId, loanReference: loan.reference, entityId: loan.entityId, effectiveDate,
    oldInstalmentCents: schedule.referenceInstalmentCents, newInstalmentCents: solved.baseInstalmentCents,
  })
  await logAuditStrict({
    tenantId,
    userId: request.actorUserId,
    action: AuditAction.LOAN_REPRICED,
    entity: "Loan",
    entityId: loanId,
    oldValue: {
      contractRateEffectiveDate: isoOfDbDate(prior.effectiveDate),
      resultingRate: prior.resultingRate.toString(),
      interestRatePm: loan.interestRatePm,
      baseInstalmentCents: schedule.referenceInstalmentCents,
    },
    newValue: {
      contractRateId, effectiveDate, basis, referenceRate: reference.rate.toString(),
      referenceEffectiveDate: reference.effectiveDate, margin: prior.margin.toString(),
      resultingRate: resultingRate.toString(), baseInstalmentCents: solved.baseInstalmentCents,
      firstRepricedInstallmentNo: stored[paid + 1].installmentNo, rowsRepriced: solved.rows.length,
      totalRepayableChangeCents: totalChange, noticeRecipientClientIds, noticeSent: false,
      source: request.actorUserId ? "staff" : "cron",
    },
  }, tx)
  // Deferred schedule/ledger guards would otherwise fire at COMMIT, where
  // Prisma reports a rolled-back transaction as success (lib/loan/apply-payment.ts).
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")

  return {
    kind: "repriced",
    contractRateId,
    resultingRate: resultingRate.toString(),
    oldInstalmentCents: schedule.referenceInstalmentCents,
    newInstalmentCents: solved.baseInstalmentCents,
    rowsRepriced: solved.rows.length,
    noticeRecipientClientIds,
  }
}
