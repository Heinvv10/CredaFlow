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
 * A late rate restates paid periods' interest/principal allocations while
 * preserving their cash and payment state; their corrected closing balance
 * carries the debit or credit into the future solve, with a strict audit.
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
import { noticeKeptThroughIndex, repriceTail, REPRICE_NOTICE_DAYS } from "./reprice"
import { queueRepriceNotice } from "./reprice-notice"
import { storedScheduleForReprice, type StoredScheduleError } from "./stored-schedule"
import { maxAssetFinanceAnnualRate } from "./nca-caps"
import { isLeaseContract } from "./lease-input"
import { leaseCapitalRows, writeLeaseRepricedRows } from "./lease-reprice"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { dueDateInstant, toScheduleRecord } from "./schedule-records"
import { assetRateRepriceBaseline } from "./reprice-baseline"
import { writeClosedLeaseRateCorrection } from "./reprice-closed-lease"
import { leaseRentalFloorPlan } from "./lease-rental-floor"
import { writeLeaseRentalFloor } from "./lease-rental-floor-write"
import { ratePayoffPlan } from "./reprice-payoff"
import { writeRatePayoff } from "./reprice-payoff-write"
import { lawfulRateCorrection } from "./lawful-rate-correction"
import { correctionCashEvents, correctionBalance } from "./rate-correction"
import { commonLawContractualRows } from "./common-law-interest"
import { loadSettlementEvidence } from "@/lib/loan/contractual-schedule"
import { loadChargesReplay } from "@/lib/loan/charges-replay"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { restateSettledSchedule } from "./reprice-restatement"
import { writeRestatedRows, writeRepricedRows } from "./reprice-writes"

export type RepriceTx = Pick<
  typeof prisma,
  "$queryRaw" | "$executeRaw" | "$executeRawUnsafe" | "loan" | "repaymentSchedule" | "contractRate" | "referenceRate" | "auditLog" | "entityRelationship" | "user" | "notification"
  | "leaseRental" | "assetFinanceDeal" | "client" | "assetFinanceRateNotice" | "payment" | "complianceRecord" | "loanCharge" | "assetFinanceRateCorrection" | "bankTransaction" | "taxInvoice" | "creditNote" | "vatConfig" | "vatRate"
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
  | "contract_cancelled"
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
      id: true, reference: true, status: true, commercialCancelledAt: true, contractType: true, ncaRegime: true,
      entityId: true, balloonAmount: true, startDate: true, interestRatePm: true,
      assetFinanceWeights: true, application: { select: { pasqEvidence: true } },
      contractualTotalInterest: true, contractualTotalRepayable: true, totalInterest: true, monthlyServiceFee: true, principal: true, closedAt: true,
    },
  })
  if (!loan) return notEligible("loan_not_found")
  if (loan.commercialCancelledAt) return notEligible("contract_cancelled")
  const existing = await tx.contractRate.findFirst({
    where: { tenantId, loanId, effectiveDate: dbDate(effectiveDate) },
    select: { id: true },
  })
  if (existing) return { kind: "already_repriced" }

  if (loan.status !== "ACTIVE" && loan.status !== "COMPLETED") return notEligible("not_active")
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
    where: { tenantId, loanId, effectiveDate: { lt: dbDate(effectiveDate) }, newInstalmentCents: { gt: 0 } },
    orderBy: { effectiveDate: "desc" },
    select: { newInstalmentCents: true },
  })
  const rawStored = await tx.repaymentSchedule.findMany({
    where: { loanId, tenantId },
    orderBy: { installmentNo: "asc" },
    select: {
      id: true, installmentNo: true, dueDate: true, principalDue: true, interestDue: true, feesDue: true,
      creditLifePremiumDue: true, totalDue: true, totalPaid: true, status: true, assetFinanceOpeningBalanceCents: true, commonLawContractualInterestDue: true,
    },
  })
  const stored = commonLawContractualRows(rawStored.map((row) => ({ ...row, collectibleTotalDue: row.totalDue })))
  const lease = isLeaseContract(loan.contractType) ? await leaseCapitalRows(tx, tenantId, loanId, stored) : null
  if (lease && "error" in lease) return notEligible(lease.error)
  const balloonCents = lease ? lease.residualCents : loan.balloonAmount ?? 0
  const startDate = sastCalendarDate(loan.startDate)
  const history = await contractRatePath(tx, tenantId, loanId) // all before effectiveDate: none later, none on it
  const correctionLedger = await tx.assetFinanceRateCorrection.findMany({ where: { tenantId, loanId }, include: { contractRate: { select: { effectiveDate: true } } } })
  const appliedDates = correctionLedger.filter((row) => row.reason === "APPLIED_TO_SCHEDULE").map((row) => isoOfDbDate(row.contractRate.effectiveDate))
  const ledgerOnlyDates = new Set(correctionLedger.filter((row) => ["LATE_CLOSED_BOOK_RATE", "FIXED_NOTICE_WINDOW_RATE", "LATE_CLOSED_LEASE_RATE"].includes(row.reason) && !appliedDates.some((day) => day > isoOfDbDate(row.contractRate.effectiveDate))).map((row) => isoOfDbDate(row.contractRate.effectiveDate)))
  const billedHistory = history.filter((point) => !ledgerOnlyDates.has(point.effectiveDate))
  const monthlyServiceFee = loan.ncaRegime === "NCA" ? loan.monthlyServiceFee ?? 0 : 0
  const pendingCashRows = rawStored.filter((row) => row.totalDue > row.totalPaid)
  const fixedFinalWindow = pendingCashRows.length === 0 || pendingCashRows.every((row) => toDayNumber(sastCalendarDate(row.dueDate)) < toDayNumber(request.runDate) + REPRICE_NOTICE_DAYS)
  if (lease && (loan.status === "COMPLETED" || fixedFinalWindow)) return writeClosedLeaseRateCorrection(tx, { request, view: lease, startDate, oldPath: billedHistory, newPath: [...history, { effectiveDate, annualRate: resultingRate.toNumber() }], resultingRate, margin: prior.margin, ledgerOnlyDates, loan })
  if (loan.status === "COMPLETED" || fixedFinalWindow) {
    const newPath = [...history, { effectiveDate, annualRate: resultingRate.toNumber() }]
    const receipts = await tx.payment.findMany({ where: { tenantId, loanId, reversed: false, allocationStatus: "ALLOCATED" }, orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { amount: true, receivedAt: true, defaultInterestAllocated: true, chargeFeesAllocated: true } })
    const events = correctionCashEvents(rawStored, receipts)
    if (loan.status !== "COMPLETED") for (const row of pendingCashRows) {
      const feesPaid = Math.min(row.feesDue, Math.max(0, row.totalPaid - row.interestDue))
      events.push({ day: [sastCalendarDate(row.dueDate), request.runDate].sort().at(-1)!, capitalCashCents: row.totalDue - row.totalPaid - row.feesDue + feesPaid })
    }
    // Remove earlier ledger-only points to recover the immutable billed path;
    // all correction events together form the actual effective path.
    const previous = await tx.assetFinanceRateCorrection.findMany({ where: { tenantId, loanId }, include: { contractRate: { select: { effectiveDate: true } } } })
    const billedPath = billedHistory
    const oldBalance = correctionBalance(loan.principal, startDate, billedPath, events)
    const corrected = correctionBalance(loan.principal, startDate, newPath, events)
    const closedReplay = loan.ncaRegime === "NON_NCA" ? await loadChargesReplay(tx, { tenantId, loanId }, loan.closedAt ?? dueDateInstant(request.runDate), { decidingStatus: true }) : null
    if (loan.ncaRegime === "NON_NCA" && !closedReplay) throw new Error("Closed rate correction needs its common-law replay")
    const settlementEvidence = closedReplay ? (await loadSettlementEvidence(tx, tenantId, [loanId])).get(loanId) : null
    const legalSourceRows = settlementEvidence ? rawStored.map((row) => ({ ...row, ...settlementEvidence.rows.find((saved) => saved.id === row.id)! })) : rawStored
    const cumulativeAmountCents = closedReplay ? lawfulRateCorrection(closedReplay, legalSourceRows, startDate, billedPath, newPath, loan.closedAt ?? dueDateInstant(request.runDate), corrected - oldBalance) : corrected - oldBalance
    const previousAmount = previous.reduce((sum, row) => sum + row.amountCents, 0)
    const amountCents = cumulativeAmountCents - previousAmount
    const created = await tx.contractRate.create({ data: { tenantId, loanId, effectiveDate: dbDate(effectiveDate), basis, margin: prior.margin, resultingRate, newInstalmentCents: 0 } })
    await tx.assetFinanceRateCorrection.create({ data: { tenantId, loanId, contractRateId: created.id, cause: `RATE:${created.id}`, amountCents, cumulativeAmountCents, reason: loan.status === "COMPLETED" ? "LATE_CLOSED_BOOK_RATE" : "FIXED_NOTICE_WINDOW_RATE", contractualRows: { events, rows: rawStored.map((row) => ({ totalDue: row.totalDue, interestDue: row.interestDue, feesDue: row.feesDue })), principalCents: loan.principal, startDate, billedPath, correctedPath: newPath, oldBalance, correctedBalance: corrected } } })
    const recipients = await queueRepriceNotice(tx, { tenantId, loanId, entityId: loan.entityId, loanReference: loan.reference, contractRateId: created.id, resultingRate: resultingRate.toString(), effectiveDate, firstChangedPaymentDate: request.runDate, oldInstalmentCents: 0, newInstalmentCents: 0, historicalBalanceAdjustmentCents: amountCents, correctionPendingManual: true, totalInterestCents: loan.totalInterest + cumulativeAmountCents, monthlyInterestCents: 0 })
    await logAuditStrict({ tenantId, userId: request.actorUserId, action: AuditAction.LOAN_REPRICED, entity: "Loan", entityId: loanId, newValue: { contractRateId: created.id, effectiveDate, amountCents, cumulativeAmountCents, correctionPendingManual: true, source: "late_closed_book_rate" } }, tx)
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return { kind: "repriced", contractRateId: created.id, resultingRate: resultingRate.toString(), oldInstalmentCents: 0, newInstalmentCents: 0, rowsRepriced: 0, noticeRecipientClientIds: recipients }
  }
  const schedule = storedScheduleForReprice({
    stored: lease ? lease.rows : stored, balloonCents, recordedBaseCents: recordedBase?.newInstalmentCents == null ? null : recordedBase.newInstalmentCents - monthlyServiceFee, ratePath: billedHistory, startDate,
    contractualWeights: loan.assetFinanceWeights, allowZeroReference: lease !== null,
  })
  if ("error" in schedule) return notEligible(schedule.error)

  const paid = schedule.paidThroughIndex
  const newPath = [...history, { effectiveDate, annualRate: resultingRate.toNumber() }]
  let restatement = restateSettledSchedule({
    stored: lease ? lease.rows : stored, paidThroughIndex: paid, originalClosingBalanceCents: schedule.capitalOutstandingCents,
    startDate, oldPath: billedHistory, newPath, effectiveDate: [...ledgerOnlyDates, effectiveDate].sort()[0],
  })
  if (!lease && restatement.closingBalanceCents <= 0) {
    const financedAmountCents = stored[0].assetFinanceOpeningBalanceCents ?? restateSettledSchedule({ stored, paidThroughIndex: paid, originalClosingBalanceCents: schedule.capitalOutstandingCents, startDate, oldPath: billedHistory, newPath: billedHistory, effectiveDate: startDate }).rows[0].openingBalanceCents
    let plan = ratePayoffPlan({ rows: stored, paidThroughIndex: paid, financedAmountCents, startDate, ratePath: newPath })
    if (loan.ncaRegime === "NON_NCA") {
      const replay = await loadChargesReplay(tx, { tenantId, loanId }, dueDateInstant(request.runDate), { decidingStatus: true })
      if (!replay) throw new Error("Rate payoff needs its common-law replay")
      let stable = false
      for (let attempt = 0; attempt <= stored.length + 1; attempt++) {
        const result = replay.replayAt(dueDateInstant(request.runDate), [], { schedule: plan.rows.map((row) => ({ ...row, commonLawContractualInterestDue: null })), contractRateHistory: newPath.map((point) => ({ effectiveDate: dbDate(point.effectiveDate), annualRate: point.annualRate })) })
        const next = ratePayoffPlan({ rows: stored, paidThroughIndex: paid, financedAmountCents, startDate, ratePath: newPath, lawfulInterestCents: result.lawfulSchedule!.map((row) => row.interestDue) })
        stable = next.amountDue === plan.amountDue && next.payoffIndex === plan.payoffIndex
        plan = next
        if (stable) break
      }
      if (!stable) throw new Error("Common-law payoff did not reconcile")
    }
    return writeRatePayoff(tx, { request, loan, rows: stored, plan, resultingRate, margin: prior.margin, oldInstalmentCents: schedule.referenceInstalmentCents + monthlyServiceFee, path: newPath })
  }
  const kept = noticeKeptThroughIndex(schedule.rows, paid, request.runDate)
  if (kept >= schedule.rows.length - 1) return notEligible("within_notice_period")
  if (lease) {
    const openingCents = stored[0].assetFinanceOpeningBalanceCents
    if (openingCents == null) return notEligible("unsupported_schedule")
    const plan = leaseRentalFloorPlan({
      openingCents, residualCents: lease.residualCents, startDate, effectiveDate,
      paidThroughIndex: paid, keptThroughIndex: kept, ratePath: newPath,
      rentals: stored.map(row => ({ dueDate: isoOfDbDate(row.dueDate), rentalExclVatCents: lease.rentals.get(row.installmentNo)!.rentalExclVatCents })),
    })
    if (plan) return writeLeaseRentalFloor(tx, { request, loan, view: lease, stored, plan, paid, kept, path: newPath, resultingRate, margin: prior.margin })
  }
  let solved = repriceTail({
    rows: schedule.rows,
    paidThroughIndex: paid,
    keptThroughIndex: kept,
    balanceAtRepriceCents: restatement.closingBalanceCents,
    repriceDate: paid >= 0 ? schedule.rows[paid].dueDate : startDate,
    ratePath: newPath,
    balloonCents,
    firstDueOnAccrualStart: lease !== null && lease.advance && paid === -1,
  })

  if (loan.ncaRegime === "NON_NCA" && !lease) {
    const replay = await loadChargesReplay(tx, { tenantId, loanId }, dueDateInstant(request.runDate), { decidingStatus: true })
    if (!replay) throw new Error("Rate correction needs its common-law replay")
    let stable = false
    for (let attempt = 0; attempt <= stored.length + 1; attempt++) {
      const proposed = stored.map((row) => ({ ...row }))
      for (const row of [...restatement.rows, ...solved.rows]) {
        const original = proposed[row.index]
        const billed = toScheduleRecord(row)
        const fullInterest = restatement.contractualInterestByIndex?.[row.index] ?? billed.interestDue
        proposed[row.index] = { ...original, principalDue: billed.principalDue, interestDue: fullInterest,
          commonLawContractualInterestDue: fullInterest, totalDue: billed.totalDue + original.feesDue + fullInterest - billed.interestDue }
      }
      const projected = replay.replayAt(dueDateInstant(request.runDate), [], { schedule: proposed, contractRateHistory: newPath.map((point) => ({ effectiveDate: dbDate(point.effectiveDate), annualRate: point.annualRate })) })
      const lawful = projected.lawfulSchedule!.map((row) => row.interestDue)
      const next = restateSettledSchedule({ stored, paidThroughIndex: paid, originalClosingBalanceCents: schedule.capitalOutstandingCents, startDate, oldPath: billedHistory, newPath, effectiveDate: [...ledgerOnlyDates, effectiveDate].sort()[0], lawfulInterestCents: lawful })
      stable = next.closingBalanceCents === restatement.closingBalanceCents && next.rows.every((row, i) => row.interestCents === restatement.rows[i]?.interestCents)
      restatement = next
      solved = repriceTail({ rows: schedule.rows, paidThroughIndex: paid, keptThroughIndex: kept, balanceAtRepriceCents: restatement.closingBalanceCents, repriceDate: paid >= 0 ? schedule.rows[paid].dueDate : startDate, ratePath: newPath, balloonCents })
      if (stable) break
    }
    if (!stable) throw new Error("Proposed common-law rate correction did not reconcile")
  }

  // The first write: on a lost race the unique index refuses it before
  // anything else has changed.
  let contractRateId: string
  try {
    const created = await tx.contractRate.create({
      data: {
        tenantId, loanId, effectiveDate: dbDate(effectiveDate), basis, margin: prior.margin,
        resultingRate, newInstalmentCents: solved.baseInstalmentCents + monthlyServiceFee, createdById: request.actorUserId ?? null,
      },
      select: { id: true },
    })
    contractRateId = created.id
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "already_repriced" }
    throw error
  }

  const restated = await writeRestatedRows(tx, tenantId, loanId, stored, restatement.rows, lease !== null, restatement.contractualInterestByIndex)
  if (restatement.rows.length > 0) {
    await logAuditStrict({
      tenantId, userId: request.actorUserId, action: AuditAction.LOAN_RATE_RESTATED, entity: "Loan", entityId: loanId,
      oldValue: { rows: restatement.rows.map((row) => ({ installmentNo: row.index + 1, principalDue: stored[row.index].principalDue,
        interestDue: stored[row.index].interestDue, totalDue: stored[row.index].totalDue, totalPaid: stored[row.index].totalPaid,
        openingBalanceCents: stored[row.index].assetFinanceOpeningBalanceCents })) },
      newValue: { contractRateId, effectiveDate, adjustmentCents: restatement.adjustmentCents,
        rows: restatement.rows.map((row) => ({ installmentNo: row.index + 1, openingBalanceCents: row.openingBalanceCents,
          interestAccruedCents: row.interestCents, capitalCashCents: row.totalCents, closingBalanceCents: row.closingBalanceCents })) },
    }, tx)
  }
  const leaseChange = lease ? await writeLeaseRepricedRows(tx, tenantId, loanId, lease, stored, solved.rows) : null
  const change = leaseChange === null
    ? await writeRepricedRows(tx, tenantId, loanId, stored, solved.rows)
    : { principal: leaseChange, interest: 0, total: leaseChange }
  const finalRows = await tx.repaymentSchedule.findMany({ where: { tenantId, loanId }, orderBy: { installmentNo: "asc" },
    select: { id: true, installmentNo: true, principalDue: true, interestDue: true, feesDue: true, creditLifePremiumDue: true, totalDue: true, totalPaid: true, dueDate: true, assetFinanceOpeningBalanceCents: true, commonLawContractualInterestDue: true } })
  const newPrincipal = finalRows.reduce((sum, row) => sum + row.principalDue, 0)
  const balances = recomputeLoanBalances(newPrincipal, finalRows, dueDateInstant(request.runDate))
  const loanUpdated = await tx.loan.updateMany({
    where: { id: loanId, tenantId, status: "ACTIVE" },
    data: {
      // Paid cash stays fixed, but its allocation can change on a late rate.
      // Recompute outstanding principal from the final allocation, not the net
      // change in all principal (which includes already-paid principal).
      principal: newPrincipal,
      outstandingPrincipal: balances.outstandingPrincipal,
      totalInterest: finalRows.reduce((sum, row) => sum + row.interestDue, 0),
      totalRepayable: finalRows.reduce((sum, row) => sum + row.totalDue, 0),
      ...(loan.contractualTotalInterest === null ? {} : { contractualTotalInterest: finalRows.reduce((sum, row) => sum + (row.commonLawContractualInterestDue ?? row.interestDue), 0) }),
      ...(loan.contractualTotalRepayable === null ? {} : { contractualTotalRepayable: finalRows.reduce((sum, row) => sum + row.totalDue + (row.commonLawContractualInterestDue ?? row.interestDue) - row.interestDue, 0) }),
      interestRatePm: resultingRate.div(12).toNumber(),
    },
  })
  if (loanUpdated.count !== 1) throw new Error(`reprice: loan ${loanId} changed underneath the repricing`)

  if (ledgerOnlyDates.size) {
    const pending = correctionLedger.reduce((sum, row) => sum + row.amountCents, 0)
    await tx.assetFinanceRateCorrection.create({ data: { tenantId, loanId, contractRateId, cause: `SCHEDULE:${contractRateId}`, amountCents: -pending, cumulativeAmountCents: 0, reason: "APPLIED_TO_SCHEDULE", contractualRows: { appliedRateDates: [...ledgerOnlyDates], pendingAmountCents: pending } } })
  }
  const firstChangedPayment = await tx.repaymentSchedule.findFirstOrThrow({
    where: { tenantId, loanId, id: stored[kept + 1].id }, select: { totalDue: true, interestDue: true },
  })
  const noticeRecipientClientIds = await queueRepriceNotice(tx, {
    tenantId, loanId, loanReference: loan.reference, entityId: loan.entityId, effectiveDate, contractRateId, resultingRate: resultingRate.toString(),
    firstChangedPaymentDate: solved.rows[kept - paid].dueDate,
    oldInstalmentCents: stored[kept + 1].totalDue, newInstalmentCents: firstChangedPayment.totalDue,
    historicalBalanceAdjustmentCents: restatement.adjustmentCents,
    totalInterestCents: loan.totalInterest + change.interest + restated.interest, monthlyInterestCents: firstChangedPayment.interestDue,
  })
  const revisedBaseline = loan.ncaRegime === "NCA" ? assetRateRepriceBaseline({
    original: loan.application.pasqEvidence, contractRateId, annualRate: resultingRate.toString(), effectiveDate,
    recurringPaymentCents: solved.baseInstalmentCents + monthlyServiceFee, rows: finalRows,
  }) : null
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
      baseInstalmentCents: schedule.referenceInstalmentCents + monthlyServiceFee,
    },
    newValue: {
      contractRateId, effectiveDate, runDate: request.runDate, basis, referenceRate: reference.rate.toString(),
      referenceEffectiveDate: reference.effectiveDate, margin: prior.margin.toString(),
      resultingRate: resultingRate.toString(), baseInstalmentCents: solved.baseInstalmentCents + monthlyServiceFee,
      firstRepricedInstallmentNo: stored[kept + 1].installmentNo, rowsRepriced: solved.rows.length - (kept - paid),
      rowsKeptForNotice: kept - paid, principalChangeCents: change.principal, interestChangeCents: change.interest,
      totalRepayableChangeCents: change.total, noticeRecipientClientIds, noticeSent: false, noticeQueued: true,
      ...(revisedBaseline ? { assetRateRepriceEvidence: revisedBaseline } : {}),
      historicalBalanceAdjustmentCents: restatement.adjustmentCents, restatedPeriods: restatement.rows.length,
      source: request.actorUserId ? "staff" : "cron",
    },
  }, tx)
  // Deferred schedule/ledger guards would otherwise fire at COMMIT, where
  // Prisma reports a rolled-back transaction as success (lib/loan/apply-payment.ts).
  if (loan.ncaRegime === "NON_NCA") await syncLoanCharges(tx, { tenantId, loanId }, dueDateInstant(request.runDate), { source: "asset-finance-rate-reprice", userId: request.actorUserId })
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")

  return {
    kind: "repriced",
    contractRateId,
    resultingRate: resultingRate.toString(),
    oldInstalmentCents: schedule.referenceInstalmentCents + monthlyServiceFee,
    newInstalmentCents: solved.baseInstalmentCents + monthlyServiceFee,
    rowsRepriced: solved.rows.length - (kept - paid),
    noticeRecipientClientIds,
  }
}
