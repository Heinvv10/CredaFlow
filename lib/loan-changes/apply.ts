/**
 * Makes an approved change, inside the approval's transaction: any throw rolls the approval back too. The loans are locked
 * first, as every receipt path locks them, and the change is computed again under the locks. Rules: lib/loan-changes/.claude.md.
 */
import type { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { applyManualReceiptInTx } from "@/lib/loan/apply-payment"
import { unusedLoanReference } from "@/lib/loan/loan-reference"
import { generateReference } from "@/lib/utils"
import { PERIOD_DAYS } from "@/lib/product-engine/types"
import type { ApplyContext, Tx } from "@/lib/maker-checker/types"
import { computeChange, inArrears, involvedLoanIds, type ChangeLoan, type InPlaceComputed, type NewLoanComputed } from "./compute"
import { LoanChangeRefused } from "./plan"
import { LOAN_SETTLEMENT_METHOD } from "@/lib/payments/waiver"
import type { LoanChangePayload } from "./types"

type Ctx = ApplyContext<LoanChangePayload>

/** A change that eases terms for a borrower who cannot meet them. Any change to a loan in arrears is one too. */
const FORBEARANCE_TYPES: readonly string[] = ["RESCHEDULE", "RESTRUCTURE", "PAYMENT_HOLIDAY"]

export const isForbearance = (type: string, loans: ChangeLoan[], asOf: Date) =>
  FORBEARANCE_TYPES.includes(type) || loans.some((loan) => inArrears(loan, asOf))

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

const figures = (loan: ChangeLoan) => ({
  loanId: loan.id, reference: loan.reference, status: loan.status, interestRatePm: loan.interestRatePm, maturityDate: loan.maturityDate, principal: loan.principal,
  outstandingPrincipal: loan.outstandingPrincipal, totalRepayable: loan.totalRepayable, totalPaid: loan.totalPaid, arrearsAmount: loan.arrearsAmount, daysInArrears: loan.daysInArrears,
})

const scheduleOf = (loan: ChangeLoan) => ({
  loanId: loan.id,
  rows: loan.repaymentSchedule.map(({ id, installmentNo, dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid, status, paidAt }) => ({ id, installmentNo, dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid, status, paidAt })),
})

const scheduleRow = (tenantId: string, loanId: string) => (row: { installmentNo: number; dueDate: Date; principalDue: number; interestDue: number; feesDue: number; totalDue: number }) => ({
  tenantId, loanId, installmentNo: row.installmentNo, dueDate: row.dueDate, principalDue: row.principalDue, interestDue: row.interestDue,
  creditLifePremiumDue: 0, feesDue: row.feesDue, totalDue: row.totalDue, status: "PENDING" as const,
})

async function applyInPlace(tx: Tx, ctx: Ctx, { loan, plan }: InPlaceComputed): Promise<void> {
  const { tenantId, request, payload, checker, now } = ctx
  const restructured = isForbearance(payload.type, [loan], now)
  for (const row of plan.trim) {
    await tx.repaymentSchedule.update({
      where: { id: row.id, tenantId },
      data: { principalDue: row.principalDue, interestDue: row.interestDue, feesDue: row.feesDue, totalDue: row.totalDue, status: "PAID", paidAt: loan.lastPaymentDate ?? now },
    })
  }
  await tx.repaymentSchedule.deleteMany({ where: { tenantId, loanId: loan.id, id: { in: plan.remove } } })
  await tx.repaymentSchedule.createMany({ data: plan.fresh.map(scheduleRow(tenantId, loan.id)) })
  const status = loan.status === "DEFAULTED" && plan.arrearsAmount === 0 ? "ACTIVE" : loan.status
  await tx.loan.update({
    where: { id: loan.id, tenantId },
    data: {
      interestRatePm: plan.interestRatePm, totalInterest: plan.totalInterest, totalRepayable: plan.totalRepayable,
      contractualTotalInterest: plan.totalInterest, contractualTotalRepayable: plan.totalRepayable,
      maturityDate: plan.maturityDate, nextPaymentDate: plan.nextPaymentDate, outstandingPrincipal: plan.outstandingPrincipal,
      arrearsAmount: plan.arrearsAmount, daysInArrears: plan.daysInArrears, status,
      ...(restructured ? { restructuredAt: now } : {}),
    },
  })
  // A loan with no terms row was written before its product had a version: its first change records the origination too.
  let sequence = loan.terms[0]?.sequence ?? 0
  if (sequence === 0) {
    sequence = 1
    await tx.loanTerms.create({ data: { tenantId, loanId: loan.id, sequence, changeRequestId: request.id, baseRatePm: loan.interestRatePm, interestRatePm: loan.interestRatePm } })
  }
  await tx.loanTerms.create({
    data: {
      tenantId, loanId: loan.id, sequence: sequence + 1, productVersionId: loan.terms[0]?.productVersionId ?? null, changeRequestId: request.id,
      frequency: plan.terms.frequency, structure: plan.terms.structure, graceKind: plan.terms.graceKind, graceInstalments: plan.terms.graceInstalments, instalments: plan.terms.instalments,
      baseRatePm: plan.interestRatePm, interestRatePm: plan.interestRatePm, deferredInterest: plan.deferredInterest,
    },
  })
  const after = { ...figures(loan), status, interestRatePm: plan.interestRatePm, maturityDate: plan.maturityDate, outstandingPrincipal: plan.outstandingPrincipal, totalRepayable: plan.totalRepayable, arrearsAmount: plan.arrearsAmount, daysInArrears: plan.daysInArrears }
  await tx.loanChange.create({
    data: {
      tenantId, loanId: loan.id, type: payload.type, changeRequestId: request.id, makerId: request.makerId, checkerId: checker.id, reason: payload.reason,
      signedDocumentId: payload.signedDocumentId, markedRestructured: restructured,
      before: json(figures(loan)), after: json(after),
      scheduleBefore: json([scheduleOf(loan)]), scheduleAfter: json([{ loanId: loan.id, rows: plan.rows }]),
    },
  })
  await logAuditStrict({
    tenantId, userId: checker.id, userEmail: checker.email, action: AuditAction.LOAN_CHANGE_APPLIED, entity: "Loan", entityId: loan.id,
    oldValue: json(figures(loan)) as Record<string, unknown>,
    newValue: { type: payload.type, changeRequestId: request.id, makerId: request.makerId, signedDocumentId: payload.signedDocumentId, restructured, carriedInterest: plan.carriedInterest, carriedFees: plan.carriedFees, ...(json(after) as Record<string, unknown>) },
  }, tx)
  if (status !== loan.status) {
    await logAuditStrict({
      tenantId, userId: checker.id, userEmail: checker.email, action: AuditAction.LOAN_STATUS_CHANGED, entity: "Loan", entityId: loan.id,
      oldValue: { status: loan.status }, newValue: { status, reason: "loan_change", changeRequestId: request.id },
    }, tx)
  }
}

async function applyNewLoan(tx: Tx, ctx: Ctx, computed: NewLoanComputed): Promise<void> {
  const { tenantId, request, payload, checker, now } = ctx
  const { primary, settled, settledCents, newMoneyCents, interestRatePm, plan } = computed
  const client = primary.client!
  const restructured = isForbearance(payload.type, settled.map((s) => s.loan), now)
  const payoutReference = payload.type === "TOP_UP" ? payload.payoutReference : null
  const termDays = plan.terms.instalments * PERIOD_DAYS[plan.terms.frequency]
  // The checker approves and the maker books, as an approver never disburses: the database holds both.
  const application = await tx.loanApplication.create({
    data: {
      tenantId, reference: generateReference("APP"), clientId: client.id, productId: primary.productId, branchId: primary.application.branchId,
      appliedAmount: plan.principal, appliedTermDays: termDays, purpose: primary.application.purpose, status: "APPROVED",
      approvedAt: now, approvedById: checker.id, approvedAmount: plan.principal, approvedTermDays: termDays, repaymentMethod: "EFT",
      loanChangeRequestId: request.id,
    },
  })
  await tx.loanApplication.update({
    where: { id: application.id, tenantId },
    data: {
      status: "DISBURSED", disbursedAt: now, disbursedById: request.makerId, disbursementRef: payoutReference,
      disbursementBank: client.bankName, disbursementAccountNo: client.bankAccountNumber, disbursementBranchCode: client.bankBranchCode, disbursementAccountType: client.accountType,
    },
  })
  const created = await tx.loan.create({
    data: {
      tenantId, applicationId: application.id, clientId: client.id, productId: primary.productId,
      reference: await unusedLoanReference(async (reference) => Boolean(await tx.loan.findFirst({ where: { reference }, select: { id: true } }))),
      principal: plan.principal, totalInterest: plan.totalInterest, initiationFee: 0, creditLifePremiums: 0, totalRepayable: plan.totalRepayable,
      contractualTotalInterest: plan.totalInterest, contractualTotalRepayable: plan.totalRepayable, outstandingPrincipal: plan.principal,
      status: "ACTIVE", startDate: now, maturityDate: plan.maturityDate, nextPaymentDate: plan.rows[0]!.dueDate, interestRatePm, interestModel: primary.interestModel,
      monthlyServiceFee: primary.monthlyServiceFee ?? 0, agreementDocId: payload.signedDocumentId, ...(restructured ? { restructuredAt: now } : {}),
    },
  })
  await tx.repaymentSchedule.createMany({ data: plan.rows.map(scheduleRow(tenantId, created.id)) })
  await tx.loanTerms.create({
    data: {
      tenantId, loanId: created.id, sequence: 1, productVersionId: primary.terms[0]?.productVersionId ?? null, changeRequestId: request.id,
      frequency: plan.terms.frequency, structure: plan.terms.structure, graceKind: plan.terms.graceKind, graceInstalments: 0, instalments: plan.terms.instalments,
      baseRatePm: interestRatePm, interestRatePm,
    },
  })
  const after = { loanId: created.id, reference: created.reference, principal: plan.principal, interestRatePm, totalRepayable: plan.totalRepayable, maturityDate: plan.maturityDate, settledCents, newMoneyCents }
  const before = { loans: settled.map((s) => ({ ...figures(s.loan), settlementCents: s.settlementCents })) }
  await tx.loanChange.create({
    data: {
      tenantId, loanId: primary.id, type: payload.type, changeRequestId: request.id, makerId: request.makerId, checkerId: checker.id, reason: payload.reason,
      signedDocumentId: payload.signedDocumentId, markedRestructured: restructured, sourceLoanIds: settled.map((s) => s.loan.id), newLoanId: created.id, settledCents, newMoneyCents,
      before: json(before), after: json(after),
      scheduleBefore: json(settled.map((s) => scheduleOf(s.loan))), scheduleAfter: json([{ loanId: created.id, rows: plan.rows }]),
    },
  })
  await logAuditStrict({
    tenantId, userId: checker.id, userEmail: checker.email, action: AuditAction.LOAN_CREATED, entity: "Loan", entityId: created.id,
    newValue: { reference: created.reference, principal: plan.principal, loanChange: payload.type, changeRequestId: request.id },
  }, tx)
  await logAuditStrict({
    tenantId, userId: checker.id, userEmail: checker.email, action: AuditAction.LOAN_CHANGE_APPLIED, entity: "Loan", entityId: primary.id,
    oldValue: json(before) as Record<string, unknown>,
    newValue: { type: payload.type, changeRequestId: request.id, makerId: request.makerId, signedDocumentId: payload.signedDocumentId, restructured, payoutReference, ...(json(after) as Record<string, unknown>) },
  }, tx)
  // Each old loan closes through the receipt path: the s125 re-pricing, the charge split, the closing date and their audit rows.
  for (const { loan, settlementCents } of settled) {
    await applyManualReceiptInTx(tx, {
      loanId: loan.id, tenantId, amount: settlementCents, paymentMethod: LOAN_SETTLEMENT_METHOD, reference: created.reference,
      notes: `Settled by new loan ${created.reference}`, capturedById: checker.id, capturedByEmail: checker.email, receivedAt: now,
    })
    const closed = await tx.loan.findFirst({ where: { id: loan.id, tenantId }, select: { status: true } })
    if (closed?.status !== "COMPLETED") throw new LoanChangeRefused(`${loan.reference} did not settle in full: nothing was changed`)
  }
}

export async function applyLoanChange(tx: Tx, ctx: Ctx): Promise<void> {
  // In one order, so two approvals of overlapping consolidations cannot deadlock.
  for (const id of [...involvedLoanIds(ctx.payload)].sort()) await lockLoanForUpdate(tx, id)
  const computed = await computeChange(tx, ctx.tenantId, ctx.payload, ctx.now)
  await (computed.scope === "IN_PLACE" ? applyInPlace(tx, ctx, computed) : applyNewLoan(tx, ctx, computed))
  // Prisma can swallow an error raised at COMMIT: run the deferred reconciliation now, while the approval can still roll back.
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
}
