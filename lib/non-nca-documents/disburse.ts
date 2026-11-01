/**
 * Booking the loan of a KEY_FACTS application (a jurisdiction without the NCA): the payout side of A10b.
 *
 * The NCA route (app/api/applications/[id]/disburse) stands on the PASQ, the provider's countersignature, a debit
 * mandate and the credit-life bundle. None of those exist here. What this checks, in this order:
 *   1. the application is APPROVED and the bank reference of the transfer is recorded;
 *   2. segregation of duties: the approver (and every approval-matrix approver) does not also pay out;
 *   3. screening allows it;
 * and then, in one SERIALIZABLE transaction on the NCA route's lock protocol:
 *   4. verifyLockedCurrentAffordabilityApproval: the shared application, client and policy locks, composite KYC to
 *      payout grade (VERIFIED: for a Lesotho borrower, a recorded in-person verification or a biometric), and the
 *      frozen approval's fingerprint against the borrower's finances, the policy and the approved terms;
 *   5. the KYC and statement documents held FOR SHARE, the application and client re-read on the transaction, and
 *      everything below judged on that read;
 *   6. the borrower signed; the key facts statement and loan agreement still hold, from the version they were issued
 *      from (documentProblem: the SQL the database gate runs on the DISBURSED write);
 *   7. the borrower is not recorded as deceased;
 *   8. payout banking: the client's bank details are complete, a verified bank statement matches them, and a second
 *      person who is not the disburser confirmed that account (payout-account.ts, standing in for AVS);
 *   9. the payout falls on the agreement's start date (agreementPayableOn).
 * The loan and its schedule are booked exactly as the signed agreement printed them, the application becomes DISBURSED
 * (the database re-runs the document gate there), and the audit rows are written.
 *
 * THE PAYOUT IS MANUAL. No money is moved here: the officer makes the transfer at the bank and records its
 * reference, and every row says so (payoutChannel "MANUAL"). An automated rail is a payout provider adapter behind
 * lib/payouts/registry.ts: for Lesotho PostBank that is the core banking API of tender requirement 2.5.1
 * (lib/non-nca-documents/.claude.md, go-live conditions). Not built.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { approvalStepApproverIds } from "@/lib/approval/progress"
import { verifyLockedCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import type { AffordabilityEvidenceLockTransaction } from "@/lib/affordability/evidence-locks"
import { DisbursementBankDetailsError, resolveDisbursementBankDetails } from "@/lib/disbursement-bank-details"
import { currentVerifiedBankDetails, findVerifiedBankStatementForMandate, type DebitMandateApplication } from "@/lib/compliance/debit-mandate.server"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import { unusedLoanReference } from "@/lib/loan/loan-reference"
import { triggerNotification } from "@/lib/notifications"
import { recordDisbursementCommission } from "@/lib/referral-agents/commission"
import { readBorrowerScreening } from "@/lib/screening/gate"
import { SEGREGATION_OF_DUTIES_REFUSALS, isSegregationOfDutiesRequired, segregationOfDutiesConflict } from "@/lib/security/segregation-of-duties"
import { databaseMessage, isDatabaseRefusal } from "./errors"
import { currentPayoutVerification } from "./payout-account"
import { agreementPayableOn, KEY_FACTS_BANK_REF_MAX, KEY_FACTS_PAYOUT_NOTE, manualBankRef } from "./payout-terms"
import { documentProblem } from "./state"

type Refusal = { ok: false; status: 400 | 404 | 409 | 422; error: string; precondition: string; affordabilitySnapshot?: string }

export type KeyFactsDisbursement =
  | { ok: true; loanId: string; loanRef: string; disbursementCents: number; payoutChannel: "MANUAL" }
  | Refusal

const refuse = (status: Refusal["status"], precondition: string, error: string): Refusal => ({ ok: false, status, error, precondition })
const CHANGED = refuse(409, "changed", "The application changed while it was being disbursed; no loan was booked. Refresh and try again.")
const KYC_REFUSAL = refuse(422, "composite_kyc", "Cannot disburse: all four core KYC documents plus a current biometric or a recorded in-person verification are required before funds can move.")

/** A gate refused inside the transaction: thrown so that nothing it did stands, answered as its refusal. */
class Refused extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.error) }
}

const approvalRefusal = (reason: string): Refusal => {
  if (reason === "application_changed") return CHANGED
  if (reason === "kyc_changed") return KYC_REFUSAL
  return {
    ...refuse(422, "unchanged_affordability", "Cannot disburse: the borrower's finances, the lender's policy or the approved terms changed after approval. Return the application to review and approve it again."),
    affordabilitySnapshot: reason,
  }
}

/** Every eligible KYC and statement document of the client, as the NCA route holds them: a verification cannot be withdrawn under the payout. */
const lockKycDocuments = (tx: AffordabilityEvidenceLockTransaction, tenantId: string, clientId: string) => tx.$queryRaw(Prisma.sql`
  SELECT "id" FROM "ClientDocument"
  WHERE "tenantId" = ${tenantId} AND "clientId" = ${clientId}
    AND (
      "docType" = 'SELFIE'::"DocType"
      OR ("deletedAt" IS NULL AND "verified" = true AND "docType" IN ('ID_COPY'::"DocType", 'PROOF_OF_ADDRESS'::"DocType", 'PAYSLIP'::"DocType", 'BANK_STATEMENT'::"DocType"))
    )
  ORDER BY "id"
  FOR SHARE
`)

export async function disburseKeyFactsLoan(args: {
  tenantId: string
  applicationId: string
  user: { id: string; email: string }
  /** The reference of the transfer the officer made at the bank. */
  bankRef: unknown
}): Promise<KeyFactsDisbursement> {
  const { tenantId, applicationId, user } = args

  // A refusal is audited by the route (LOAN_DISBURSEMENT_REFUSED, from the response's `disbursementPrecondition`).
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    include: { approvedBy: { select: { isSystem: true } } },
  })
  if (!application) return refuse(404, "not_found", "Application not found")
  if (application.disclosureRegime !== "KEY_FACTS") return refuse(409, "regime", "This application is disbursed through the credit agreement ceremony, not the key-facts route")
  if (application.status !== "APPROVED") return refuse(400, "status", "Only approved applications can be disbursed")
  const clientId = application.clientId
  if (!clientId) return refuse(409, "borrower", "A key-facts loan is made to a client")
  const bankRef = manualBankRef(args.bankRef)
  if (!bankRef) return refuse(422, "bank_reference", `Cannot disburse: record the bank's reference for the manual transfer (1 to ${KEY_FACTS_BANK_REF_MAX} characters).`)

  const segregation = await isSegregationOfDutiesRequired(tenantId)
  const conflict = segregationOfDutiesConflict("disburse", user.id, {
    ...application, approvedBySystem: application.approvedBy?.isSystem === true, approvalStepApproverIds: await approvalStepApproverIds(tenantId, applicationId),
  })
  if (conflict && segregation) return refuse(422, "segregation_of_duties", SEGREGATION_OF_DUTIES_REFUSALS[conflict])

  const screening = await readBorrowerScreening(tenantId, { clientId, entityId: null })
  if (!screening.allowed) return refuse(422, "screening", `Cannot disburse: ${screening.message}`)

  try {
    const booked = await prisma.$transaction(async (tx) => {
      const locked = await verifyLockedCurrentAffordabilityApproval(tx, { tenantId, applicationId })
      if (!locked.ok) throw new Refused(approvalRefusal(locked.reason))
      await lockKycDocuments(tx, tenantId, clientId)

      // From here on every gate reads this: the row as it stands under the locks, not the one read before them.
      const current = await tx.loanApplication.findFirst({ where: { id: applicationId, tenantId, status: "APPROVED", clientId }, include: { client: true } })
      if (!current?.client) throw new Refused(CHANGED)
      const { client } = current
      if (!current.agreementSignedAt) throw new Refused(refuse(422, "signed_agreement", "Cannot disburse: the borrower has not signed the loan agreement."))
      const problem = await documentProblem(applicationId, false, tx)
      if (problem) throw new Refused(refuse(422, "non_nca_documents", `Cannot disburse: ${problem}.`))

      const kyc = await readCompositeKycState(tx as unknown as CompositeKycReader, { tenantId, clientId, subject: client, existing: client, preserveVerifiedProvenance: true })
      if (client.kycStatus !== "VERIFIED" || !kyc.ok) throw new Refused(KYC_REFUSAL)
      if (client.deceasedAt) throw new Refused(refuse(422, "deceased", "Cannot disburse: the client is recorded as deceased."))

      // The payout account: the locked client record, never a figure typed at payout, and a verified statement for exactly it.
      let bank
      try {
        bank = resolveDisbursementBankDetails({ client, request: {}, hasVerifiedBankStatement: true })
      } catch (error) {
        if (error instanceof DisbursementBankDetailsError) throw new Refused(refuse(422, "bank_details_incomplete", `Cannot disburse: ${error.message}`))
        throw error
      }
      const bankDetails = currentVerifiedBankDetails(current as unknown as DebitMandateApplication)
      if (!bankDetails) throw new Refused(refuse(422, "bank_details_incomplete", "Cannot disburse: the client's bank name, account number, branch code and account type must all be set on the client record."))
      const statement = await findVerifiedBankStatementForMandate(tx as never, { tenantId, clientId, bankDetails })
      if (!statement.ok) throw new Refused(refuse(422, statement.reason, "Cannot disburse: no verified bank statement matches the payout account."))
      const verification = await currentPayoutVerification(tx, { tenantId, applicationId, client, disburserId: user.id })
      if (!verification.ok) throw new Refused(refuse(422, "payout_account_verification", verification.error))

      // The one instant of this payout: stamped under the locks, used for every judgement and row below.
      const disbursedAt = new Date()
      const { calculation, approval } = locked
      const terms = approval.inputs
      if (!agreementPayableOn(new Date(approval.calculator.startDate), disbursedAt)) {
        throw new Refused(refuse(422, "schedule_expired", "Cannot disburse: the signed agreement could be paid out only on its start date. Return the application to review, approve it again and have the borrower sign the new agreement."))
      }
      const first = calculation.schedule[0]
      const maturityDate = calculation.schedule[calculation.schedule.length - 1].dueDate
      const repaymentMethod = current.repaymentMethod
      // decide refuses a non-EFT key-facts approval and the DB freezes the method once approved, so this is the last backstop.
      if (repaymentMethod !== "EFT") throw new Refused(refuse(422, "repayment_method", "Cannot disburse: a key-facts loan is repaid by EFT (a debit order needs a mandate this route does not prepare)."))

      const claim = await tx.loanApplication.updateMany({
        where: { id: applicationId, tenantId, status: "APPROVED", updatedAt: current.updatedAt, agreementSignedAt: { not: null } },
        data: {
          status: "DISBURSED", disbursedAt, disbursedById: user.id,
          disbursementBank: bank.bank, disbursementAccountNo: bank.accountNo, disbursementBranchCode: bank.branchCode, disbursementAccountType: bank.accountType,
          disbursementRef: bankRef,
        },
      })
      if (claim.count !== 1) throw new Refused(CHANGED)
      const created = await tx.loan.create({
        data: {
          tenantId, applicationId, clientId, productId: current.productId,
          reference: await unusedLoanReference(async (reference) => Boolean(await tx.loan.findFirst({ where: { reference }, select: { id: true } }))),
          principal: calculation.principal, totalInterest: calculation.totalInterest, initiationFee: calculation.initiationFee,
          creditLifePremiums: 0, totalRepayable: calculation.totalRepayable,
          contractualTotalInterest: calculation.totalInterest, contractualTotalRepayable: calculation.totalRepayable,
          outstandingPrincipal: calculation.principal, status: "ACTIVE", startDate: disbursedAt, maturityDate, nextPaymentDate: first.dueDate,
          interestRatePm: terms.interestRatePm, interestModel: terms.interestModel,
          monthlyServiceFee: terms.monthlyServiceFeeCents, agreementDocId: current.agreementDocumentId,
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
      await logAuditStrict({
        ...common, action: AuditAction.LOAN_CREATED, entity: "Loan", entityId: created.id,
        newValue: {
          reference: created.reference, applicationId, clientId, productId: current.productId, principal: calculation.principal, totalInterest: calculation.totalInterest,
          initiationFee: calculation.initiationFee, totalRepayable: calculation.totalRepayable, disbursementAmount: calculation.disbursementAmount,
          interestRatePm: created.interestRatePm, interestModel: created.interestModel, startDate: disbursedAt.toISOString(), maturityDate: maturityDate.toISOString(),
          scheduleItems: calculation.schedule.length, regime: "KEY_FACTS",
        },
      }, tx)
      await logAuditStrict({
        ...common, action: AuditAction.LOAN_DISBURSED, entity: "LoanApplication", entityId: applicationId,
        newValue: {
          loanId: created.id, loanRef: created.reference, principal: created.principal, segregationOfDuties: segregation, approvedById: current.approvedById,
          agreementDocumentId: current.agreementDocumentId, agreementDocumentSha256: current.agreementDocumentSha256,
          bankStatementDocumentId: statement.evidence.documentId, repaymentMethod, decisionFingerprint: approval.decisionFingerprint,
          payoutAccountVerification: { avsCheckId: verification.avsCheckId, verifiedById: verification.verifiedById },
          payoutChannel: "MANUAL", payoutReference: bankRef, payoutNote: KEY_FACTS_PAYOUT_NOTE,
        },
      }, tx)
      // The database re-runs the document gate and the commit-together rule here, inside the transaction.
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return { loan: created, disbursementCents: calculation.disbursementAmount, firstDueDate: first.dueDate }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    triggerNotification({
      tenantId, event: "loan_disbursed", loanId: booked.loan.id,
      data: { amount: booked.disbursementCents, dueDate: new Intl.DateTimeFormat("en-GB").format(booked.firstDueDate) },
    }).catch(() => undefined)
    return { ok: true, loanId: booked.loan.id, loanRef: booked.loan.reference, disbursementCents: booked.disbursementCents, payoutChannel: "MANUAL" }
  } catch (error) {
    if (error instanceof Refused) return error.refusal
    // A serialization failure: another transaction moved this evidence first.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return CHANGED
    if (isDatabaseRefusal(error)) return refuse(422, "database_guard", `Cannot disburse: ${databaseMessage(error)}`)
    throw error
  }
}
