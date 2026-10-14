/**
 * Reprices one reference-linked asset-finance loan when its reference rate
 * moves (DESIGN.md D4: term and balloon unchanged). Runs inside the caller's
 * transaction; every write below commits or rolls back together.
 *
 * ELIGIBLE: an ACTIVE NCA or NON_NCA loan whose contractType is not LOAN, and whose
 * latest ContractRate before `effectiveDate` is `basis` + a margin; the
 * reference value is the tenant's APPROVED rate in effect on effectiveDate.
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
 * `effectiveDate`. The stored schedule is read back (./stored-schedule.ts)
 * under the contract's rate path so far; the balance after the last settled
 * row (capitalised interest included) is where the re-solve starts, at that
 * row's due date (the loan's start date when none is settled), with the rate
 * path = that history plus the new point. A period straddling effectiveDate is
 * charged the old rate up to the day before and the new rate from it.
 * Settled rows are history and are never adjusted.
 *
 * NOTICE (./reprice.ts REPRICE_NOTICE_DAYS): a pending row due less than that
 * many days after `runDate` keeps its instalment; the interest the new rate
 * adds to (or takes from) those periods is absorbed by the first re-solved row
 * onward. When every pending row is inside the notice window nothing is
 * repriced (within_notice_period).
 *
 * WRITES: the ContractRate row (with the new base instalment), each pending
 * RepaymentSchedule row in place (pinned to PENDING, nothing paid), the loan's
 * principal, outstandingPrincipal, totalInterest and totalRepayable by the
 * change in the pending rows' sums (the identities in ./schedule-records.ts),
 * contractualTotalInterest and contractualTotalRepayable by the same change
 * when they are set (the agreed baseline lib/loan/settlement.ts settles on,
 * so a repriced loan settles on the repriced schedule), Loan.interestRatePm =
 * resultingRate / 12, the LOAN_REPRICED audit row and the new-instalment
 * notice (./reprice-notice.ts). The deferred constraint triggers are forced
 * before returning, so "repriced" means it will commit.
 *
 * // PARTIAL: a pending VAT-deferral lump is NOT detected. No table records a
 * deal's VAT deferral yet (DealStructure is planned, not built), and the lump
 * would read as a heavy weight and be scaled with the new instalment. Until
 * booking persists the structure, do not book a VAT-deferral deal on a
 * reference-linked rate.
 *
 * NCA asset-finance contracts are re-checked against the current prescribed
 * rate cap before any schedule or ledger write.
 *
 * LEASES (operating, full-maintenance) re-solve the same way on their capital
 * view and write back rentals, VAT and totals (./lease-reprice.ts).
 */
import { Prisma, type ReferenceRateBasis } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import { contractRatePath, referenceRateOn } from "./rates-store"
import { noticeKeptThroughIndex, repriceTail } from "./reprice"
import { queueRepriceNotice } from "./reprice-notice"
import { toScheduleRecord } from "./schedule-records"
import { storedScheduleForReprice, type StoredScheduleError } from "./stored-schedule"
import { maxAssetFinanceAnnualRate } from "./nca-caps"
import { isLeaseContract } from "./lease-input"
import { leaseCapitalRows, writeLeaseRepricedRows } from "./lease-reprice"
import { writeRepricedRows } from "./reprice-writes"

export type RepriceTx = Pick<
  typeof prisma,
  "$queryRaw" | "$executeRawUnsafe" | "loan" | "repaymentSchedule" | "contractRate" | "referenceRate" | "auditLog" | "entityRelationship" | "user" | "notification"
  | "leaseRental" | "assetFinanceDeal"
>

export interface RepriceRequest {
  tenantId: string
  loanId: string
  basis: ReferenceRateBasis
  effectiveDate: string // YYYY-MM-DD
  runDate: string // YYYY-MM-DD, the day the repricing runs: the notice window counts from it
  actorUserId?: string
}

export type NotEligibleReason =
  | "loan_not_found"
  | "not_active"
  | "not_asset_finance"
  | "nca_regime"
  | "nca_rate_cap"
  | "no_reference_rate"
  | "not_linked_to_basis"
  | "superseded" // the loan already has a contract rate from a later date
  | "within_notice_period" // every pending row falls due inside the notice window
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
  toDayNumber(request.runDate, "runDate")
  await lockLoanForUpdate(tx, loanId)

  const loan = await tx.loan.findFirst({
    where: { id: loanId, tenantId },
    select: {
      id: true, reference: true, status: true, contractType: true, ncaRegime: true,
      entityId: true, balloonAmount: true, startDate: true, interestRatePm: true,
      assetFinanceWeights: true,
      contractualTotalInterest: true, contractualTotalRepayable: true,
    },
  })
  if (!loan) return notEligible("loan_not_found")
  const existing = await tx.contractRate.findFirst({
    where: { tenantId, loanId, effectiveDate: dbDate(effectiveDate) },
    select: { id: true },
  })
  if (existing) return { kind: "already_repriced" }

  if (loan.status !== "ACTIVE") return notEligible("not_active")
  if (loan.contractType === "LOAN") return notEligible("not_asset_finance")
  if (loan.ncaRegime !== "NON_NCA" && loan.ncaRegime !== "NCA") return notEligible("nca_regime")

  const later = await tx.contractRate.findFirst({ where: { tenantId, loanId, effectiveDate: { gt: dbDate(effectiveDate) } }, select: { id: true } })
  if (later) return notEligible("superseded")
  const prior = await tx.contractRate.findFirst({
    where: { tenantId, loanId, effectiveDate: { lt: dbDate(effectiveDate) } },
    orderBy: { effectiveDate: "desc" },
    select: { basis: true, margin: true, resultingRate: true, effectiveDate: true },
  })
  if (!prior || prior.basis !== basis || prior.margin === null) return notEligible("not_linked_to_basis")
  // The new row keeps the prior basis and margin; only the resulting rate
  // moves (trigger guardContractRate refuses anything else).
  // PARTIAL: variations need a re-signed agreement
  const reference = await referenceRateOn(tx, tenantId, basis, effectiveDate)
  if (!reference) return notEligible("no_reference_rate")
  const resultingRate = reference.rate.add(prior.margin)
  if (loan.ncaRegime === "NCA") {
    const repo = await referenceRateOn(tx, tenantId, "REPO", effectiveDate)
    const cap = repo && (loan.contractType === "INSTALMENT_SALE" || loan.contractType === "FINANCE_LEASE")
      ? maxAssetFinanceAnnualRate(loan.contractType, repo.rate.toNumber())
      : null
    if (cap === null || resultingRate.gt(cap)) {
      await logAuditStrict({
        tenantId,
        userId: request.actorUserId,
        action: AuditAction.LOAN_REPRICE_REFUSED,
        entity: "Loan",
        entityId: loanId,
        oldValue: { resultingRate: prior.resultingRate.toString() },
        newValue: { effectiveDate, resultingRate: resultingRate.toString(), cap, reason: "nca_rate_cap" },
      }, tx)
      return notEligible("nca_rate_cap")
    }
  }

  const recordedBase = await tx.contractRate.findFirst({
    where: { tenantId, loanId, effectiveDate: { lt: dbDate(effectiveDate) }, newInstalmentCents: { not: null } },
    orderBy: { effectiveDate: "desc" },
    select: { newInstalmentCents: true },
  })
  const stored = await tx.repaymentSchedule.findMany({
    where: { loanId, tenantId },
    orderBy: { installmentNo: "asc" },
    select: {
      id: true, installmentNo: true, dueDate: true, principalDue: true, interestDue: true, feesDue: true,
      creditLifePremiumDue: true, totalDue: true, totalPaid: true, status: true, assetFinanceOpeningBalanceCents: true,
    },
  })
  const lease = isLeaseContract(loan.contractType) ? await leaseCapitalRows(tx, tenantId, loanId, stored) : null
  if (lease && "error" in lease) return notEligible(lease.error)
  const balloonCents = lease ? lease.residualCents : loan.balloonAmount ?? 0
  const startDate = sastCalendarDate(loan.startDate)
  const history = await contractRatePath(tx, tenantId, loanId) // all before effectiveDate: none later, none on it
  const schedule = storedScheduleForReprice({
    stored: lease ? lease.rows : stored, balloonCents, recordedBaseCents: recordedBase?.newInstalmentCents ?? null, ratePath: history, startDate,
    contractualWeights: loan.assetFinanceWeights,
  })
  if ("error" in schedule) return notEligible(schedule.error)

  const paid = schedule.paidThroughIndex
  const kept = noticeKeptThroughIndex(schedule.rows, paid, request.runDate)
  if (kept >= schedule.rows.length - 1) return notEligible("within_notice_period")
  const solved = repriceTail({
    rows: schedule.rows,
    paidThroughIndex: paid,
    keptThroughIndex: kept,
    balanceAtRepriceCents: schedule.capitalOutstandingCents,
    repriceDate: paid >= 0 ? schedule.rows[paid].dueDate : startDate,
    ratePath: [...history, { effectiveDate, annualRate: resultingRate.toNumber() }],
    balloonCents,
    firstDueOnAccrualStart: lease !== null && lease.advance && paid === -1,
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

  const leaseChange = lease ? await writeLeaseRepricedRows(tx, tenantId, loanId, lease, stored, solved.rows) : null
  const change = leaseChange === null
    ? await writeRepricedRows(tx, tenantId, loanId, stored, solved.rows)
    : { principal: leaseChange, interest: 0, total: leaseChange }
  const loanUpdated = await tx.loan.updateMany({
    where: { id: loanId, tenantId, status: "ACTIVE" },
    data: {
      // Only unpaid rows changed, so the outstanding principal moves with the principal.
      principal: { increment: change.principal },
      outstandingPrincipal: { increment: change.principal },
      totalInterest: { increment: change.interest },
      totalRepayable: { increment: change.total },
      ...(loan.contractualTotalInterest === null ? {} : { contractualTotalInterest: { increment: change.interest } }),
      ...(loan.contractualTotalRepayable === null ? {} : { contractualTotalRepayable: { increment: change.total } }),
      interestRatePm: resultingRate.div(12).toNumber(),
    },
  })
  if (loanUpdated.count !== 1) throw new Error(`reprice: loan ${loanId} changed underneath the repricing`)

  const noticeRecipientClientIds = await queueRepriceNotice(tx, {
    tenantId, loanId, loanReference: loan.reference, entityId: loan.entityId, effectiveDate,
    firstChangedPaymentDate: solved.rows[kept - paid].dueDate,
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
      contractRateId, effectiveDate, runDate: request.runDate, basis, referenceRate: reference.rate.toString(),
      referenceEffectiveDate: reference.effectiveDate, margin: prior.margin.toString(),
      resultingRate: resultingRate.toString(), baseInstalmentCents: solved.baseInstalmentCents,
      firstRepricedInstallmentNo: stored[kept + 1].installmentNo, rowsRepriced: solved.rows.length - (kept - paid),
      rowsKeptForNotice: kept - paid, principalChangeCents: change.principal, interestChangeCents: change.interest,
      totalRepayableChangeCents: change.total, noticeRecipientClientIds, noticeSent: false,
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
    rowsRepriced: solved.rows.length - (kept - paid),
    noticeRecipientClientIds,
  }
}
