/**
 * Booking the loan of a KEY_FACTS application (a jurisdiction without the NCA): the payout side of A10b.
 *
 * The NCA route (app/api/applications/[id]/disburse) stands on the PASQ, the provider's countersignature, a debit
 * mandate and the credit-life bundle. None of those exist here. What this does check, in this order:
 *   1. the application is APPROVED and its borrower signed the loan agreement;
 *   2. segregation of duties: the approver (and every approval-matrix approver) does not also pay out;
 *   3. screening allows it;
 *   4. the key facts statement and loan agreement still hold, from the version they were issued from
 *      (documentProblem: the same SQL the database gate runs on the DISBURSED write);
 *   5. composite KYC is complete to origination grade (the biometric step uses a South African face-match provider
 *      and is not asked of a key-facts borrower);
 *   6. payout banking: the client's bank details are complete and a verified bank statement matches them;
 *   7. the first instalment printed in the signed agreement has not already fallen due.
 * Then, in one transaction, the loan and its schedule are booked exactly as the signed agreement printed them
 * (lib/non-nca-documents/quote.ts: one calculation), the application becomes DISBURSED (the database re-runs the
 * document gate there), and the audit rows are written.
 *
 * THE PAYOUT IS MANUAL. No money is moved here: the officer makes the transfer at the bank and records its
 * reference, and every row says so (payoutChannel "MANUAL"). An automated rail is a payout provider adapter behind
 * lib/payouts/registry.ts: for Lesotho PostBank that is the core banking API of tender requirement 2.5.1 (a
 * disbursement call with the verified account and the idempotency key `disburse:<applicationId>`, its confirmation
 * callback, and AVS equivalent for Lesotho banks). Not built; the seam is the same one the South African channels use.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { approvalStepApproverIds } from "@/lib/approval/progress"
import { DisbursementBankDetailsError, resolveDisbursementBankDetails } from "@/lib/disbursement-bank-details"
import { currentVerifiedBankDetails, findVerifiedBankStatementForMandate, type DebitMandateApplication } from "@/lib/compliance/debit-mandate.server"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import { unusedLoanReference } from "@/lib/loan/loan-reference"
import { triggerNotification } from "@/lib/notifications"
import { recordDisbursementCommission } from "@/lib/referral-agents/commission"
import { readBorrowerScreening } from "@/lib/screening/gate"
import { SEGREGATION_OF_DUTIES_REFUSALS, isSegregationOfDutiesRequired, segregationOfDutiesConflict } from "@/lib/security/segregation-of-duties"
import { sastCalendarDate } from "@/lib/date/sast"
import { databaseMessage, isDatabaseRefusal } from "./errors"
import { approvedCalculation, QuoteUnavailableError } from "./quote"
import { documentProblem } from "./state"

export type KeyFactsDisbursement =
  | { ok: true; loanId: string; loanRef: string; disbursementCents: number; payoutChannel: "MANUAL" }
  | { ok: false; status: 400 | 404 | 409 | 422; error: string; precondition: string }

const refuse = (status: 400 | 404 | 409 | 422, precondition: string, error: string): KeyFactsDisbursement => ({ ok: false, status, error, precondition })

/** What the payout channel is, and is not, for a key-facts loan: shown with every disbursement. */
export const KEY_FACTS_PAYOUT_NOTE =
  "Manual payout: no money moved in the system. The officer makes the bank transfer and records its reference. An automated rail needs the core banking adapter (tender 2.5.1)."

export async function disburseKeyFactsLoan(args: {
  tenantId: string
  applicationId: string
  user: { id: string; email: string }
  /** The reference of the transfer the officer made at the bank. */
  bankRef: string | null
  now?: Date
}): Promise<KeyFactsDisbursement> {
  const { tenantId, applicationId, user } = args
  const disbursedAt = args.now ?? new Date()

  // A refusal is audited by the route (LOAN_DISBURSEMENT_REFUSED, from the response's `disbursementPrecondition`).
  return attempt()

  async function attempt(): Promise<KeyFactsDisbursement> {
    const application = await prisma.loanApplication.findFirst({
      where: { id: applicationId, tenantId },
      include: { client: true, approvedBy: { select: { isSystem: true } } },
    })
    if (!application?.client) return refuse(404, "not_found", "Application not found")
    if (application.disclosureRegime !== "KEY_FACTS") return refuse(409, "regime", "This application is disbursed through the credit agreement ceremony, not the key-facts route")
    if (application.status !== "APPROVED") return refuse(400, "status", "Only approved applications can be disbursed")
    const clientId = application.clientId
    if (!clientId) return refuse(409, "borrower", "A key-facts loan is made to a client")

    const segregation = await isSegregationOfDutiesRequired(tenantId)
    const conflict = segregationOfDutiesConflict("disburse", user.id, {
      ...application, approvedBySystem: application.approvedBy?.isSystem === true, approvalStepApproverIds: await approvalStepApproverIds(tenantId, applicationId),
    })
    if (conflict && segregation) return refuse(422, "segregation_of_duties", SEGREGATION_OF_DUTIES_REFUSALS[conflict])

    const screening = await readBorrowerScreening(tenantId, { clientId, entityId: null })
    if (!screening.allowed) return refuse(422, "screening", `Cannot disburse: ${screening.message}`)

    if (!application.agreementSignedAt) return refuse(422, "signed_agreement", "Cannot disburse: the borrower has not signed the loan agreement.")
    const problem = await documentProblem(applicationId, false)
    if (problem) return refuse(422, "non_nca_documents", `Cannot disburse: ${problem}.`)

    const kyc = await readCompositeKycState(prisma as unknown as CompositeKycReader, {
      tenantId, clientId, subject: application.client, existing: application.client, preserveVerifiedProvenance: true,
    })
    if (!kyc.okForOrigination) return refuse(422, "composite_kyc", "Cannot disburse: the client's KYC documents are not all verified.")

    // The payout account: the client record, never a figure typed at payout, and a verified statement for exactly it.
    let bank
    try {
      bank = resolveDisbursementBankDetails({ client: application.client, request: {}, hasVerifiedBankStatement: true })
    } catch (error) {
      if (error instanceof DisbursementBankDetailsError) return refuse(422, "bank_details_incomplete", `Cannot disburse: ${error.message}`)
      throw error
    }
    const bankDetails = currentVerifiedBankDetails(application as unknown as DebitMandateApplication)
    if (!bankDetails) return refuse(422, "bank_details_incomplete", "Cannot disburse: the client's bank name, account number, branch code and account type must all be set on the client record.")
    const statement = await findVerifiedBankStatementForMandate(prisma as never, { tenantId, clientId, bankDetails })
    if (!statement.ok) return refuse(422, statement.reason, "Cannot disburse: no verified bank statement matches the payout account.")

    let calculation, terms
    try {
      ;({ calculation, terms } = approvedCalculation(application))
    } catch (error) {
      if (error instanceof QuoteUnavailableError) return refuse(422, "approval_evidence", error.message)
      throw error
    }
    const first = calculation.schedule[0]
    if (sastCalendarDate(first.dueDate) < sastCalendarDate(disbursedAt)) {
      return refuse(422, "schedule_expired", "Cannot disburse: the first instalment date in the signed agreement has passed. Return the application to review and approve it again.")
    }
    const maturityDate = calculation.schedule[calculation.schedule.length - 1].dueDate
    const repaymentMethod = application.repaymentMethod
    // decide refuses a non-EFT key-facts approval and the DB freezes the method once approved, so this is the last backstop.
    if (repaymentMethod !== "EFT") return refuse(422, "repayment_method", "Cannot disburse: a key-facts loan is repaid by EFT (a debit order needs a mandate this route does not prepare).")

    try {
      const { loan } = await prisma.$transaction(async (tx) => {
        const claim = await tx.loanApplication.updateMany({
          where: { id: applicationId, tenantId, status: "APPROVED", updatedAt: application.updatedAt, agreementSignedAt: { not: null } },
          data: {
            status: "DISBURSED", disbursedAt, disbursedById: user.id,
            disbursementBank: bank.bank, disbursementAccountNo: bank.accountNo, disbursementBranchCode: bank.branchCode, disbursementAccountType: bank.accountType,
            disbursementRef: args.bankRef?.trim() || null,
          },
        })
        if (claim.count !== 1) throw new ChangedWhileDisbursing()
        const created = await tx.loan.create({
          data: {
            tenantId, applicationId, clientId, productId: application.productId,
            reference: await unusedLoanReference(async (reference) => Boolean(await tx.loan.findFirst({ where: { reference }, select: { id: true } }))),
            principal: calculation.principal, totalInterest: calculation.totalInterest, initiationFee: calculation.initiationFee,
            creditLifePremiums: 0, totalRepayable: calculation.totalRepayable,
            contractualTotalInterest: calculation.totalInterest, contractualTotalRepayable: calculation.totalRepayable,
            outstandingPrincipal: calculation.principal, status: "ACTIVE", startDate: disbursedAt, maturityDate, nextPaymentDate: first.dueDate,
            interestRatePm: terms.interestRatePm, interestModel: terms.interestModel,
            monthlyServiceFee: terms.monthlyServiceFeeCents, agreementDocId: application.agreementDocumentId,
          },
        })
        await tx.repaymentSchedule.createMany({
          data: calculation.schedule.map((item) => ({
            tenantId, loanId: created.id, installmentNo: item.installmentNo, dueDate: item.dueDate, principalDue: item.principalDue, interestDue: item.interestDue,
            creditLifePremiumDue: 0, feesDue: item.feesDue, totalDue: item.totalDue, status: "PENDING" as const,
          })),
        })
        await recordDisbursementCommission(tx, { tenantId, loanId: created.id, clientId, principalCents: created.principal })
        const common = { tenantId, userId: user.id, userEmail: user.email }
        await tx.auditLog.create({
          data: {
            ...common, action: AuditAction.LOAN_CREATED, entity: "Loan", entityId: created.id,
            newValue: {
              reference: created.reference, applicationId, clientId, productId: application.productId, principal: calculation.principal, totalInterest: calculation.totalInterest,
              initiationFee: calculation.initiationFee, totalRepayable: calculation.totalRepayable, disbursementAmount: calculation.disbursementAmount,
              interestRatePm: created.interestRatePm, interestModel: created.interestModel, startDate: disbursedAt.toISOString(), maturityDate: maturityDate.toISOString(),
              scheduleItems: calculation.schedule.length, regime: "KEY_FACTS",
            },
          },
        })
        await tx.auditLog.create({
          data: {
            ...common, action: AuditAction.LOAN_DISBURSED, entity: "LoanApplication", entityId: applicationId,
            newValue: {
              loanId: created.id, loanRef: created.reference, principal: created.principal, segregationOfDuties: segregation, approvedById: application.approvedById,
              agreementDocumentId: application.agreementDocumentId, agreementDocumentSha256: application.agreementDocumentSha256,
              bankStatementDocumentId: statement.evidence.documentId, repaymentMethod,
              payoutChannel: "MANUAL", payoutReference: args.bankRef?.trim() || null, payoutNote: KEY_FACTS_PAYOUT_NOTE,
            },
          },
        })
        // The database re-runs the document gate and the commit-together rule here, inside the transaction.
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
        return { loan: created }
      })

      triggerNotification({
        tenantId, event: "loan_disbursed", loanId: loan.id,
        data: { amount: calculation.disbursementAmount, dueDate: new Intl.DateTimeFormat("en-GB").format(first.dueDate) },
      }).catch(() => undefined)
      return { ok: true, loanId: loan.id, loanRef: loan.reference, disbursementCents: calculation.disbursementAmount, payoutChannel: "MANUAL" }
    } catch (error) {
      if (error instanceof ChangedWhileDisbursing) return refuse(409, "changed", "The application changed while it was being disbursed; no loan was booked. Refresh and try again.")
      if (isDatabaseRefusal(error)) return refuse(422, "database_guard", `Cannot disburse: ${databaseMessage(error)}`)
      throw error
    }
  }
}

class ChangedWhileDisbursing extends Error {}
