/**
 * Every gate of a key-facts payout (a jurisdiction without the NCA). disburse.ts books the loan on these; keyFactsPayoutCheck runs the
 * same gates and books nothing, for the application page and the disburse form. The payout is manual: the bank reference is of a transfer
 * already made, so the officer makes it only after this check passes, and a refusal at booking is a race, not the normal path.
 *
 * The NCA route (app/api/applications/[id]/disburse) stands on the PASQ, the provider's countersignature, a debit mandate and the
 * credit-life bundle. None of those exist here. What is checked, in this order:
 *   1. the application is a key-facts application, APPROVED, with a client;
 *   2. segregation of duties: the approver (and every approval-matrix approver) does not also pay out;
 *   3. screening allows it, read without locks for its message;
 * and then, in one SERIALIZABLE transaction on the NCA route's lock protocol:
 *   4. verifyLockedCurrentAffordabilityApproval: the shared application, client and policy locks, the deceased record, composite KYC to
 *      payout grade (VERIFIED: a biometric or a recorded in-person verification), and the frozen approval's fingerprint against the
 *      borrower's identity and finances, the policy and the approved terms;
 *   5. the KYC and statement documents held FOR SHARE, the application and client re-read on the transaction, and everything below judged
 *      on that read;
 *   6. screening again, under its locks;
 *   7. the borrower signed; the key facts statement and loan agreement still hold, from the version they were issued from (documentProblem:
 *      the SQL the database gate runs on the DISBURSED write);
 *   8. dealer-typed contact details are verified;
 *   9. payout banking: the client's bank details are complete, a verified bank statement matches them, and a second person who is not the
 *      disburser confirmed that account (payout-account.ts, standing in for AVS);
 *  10. the payout falls on the agreement's start date (agreementPayableOn), and repayment is by EFT.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { approvalStepApproverIds } from "@/lib/approval/progress"
import { verifyLockedCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import type { AffordabilityEvidenceLockTransaction } from "@/lib/affordability/evidence-locks"
import { DEALER_CONTACT_UNVERIFIED, dealerContactUnverified } from "@/lib/clients/dealer-contact"
import { currentVerifiedBankDetails, findVerifiedBankStatementForMandate, type DebitMandateApplication } from "@/lib/compliance/debit-mandate.server"
import { KYC_AND_STATEMENT_DOCUMENTS } from "@/lib/disbursement/document-locks"
import { DisbursementBankDetailsError, resolveDisbursementBankDetails } from "@/lib/disbursement-bank-details"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import { lockedBorrowerScreeningAllows, readBorrowerScreening } from "@/lib/screening/gate"
import { CLEARER_REFUSAL, clearedConditions, committeeConditionsRefusal } from "@/lib/approval/conditions"
import { accountControlRefusal } from "@/lib/security/account-control"
import { SEGREGATION_OF_DUTIES_REFUSALS, isSegregationOfDutiesRequired, segregationOfDutiesConflict, segregationOfDutiesMakers } from "@/lib/security/segregation-of-duties"
import { databaseMessage, isConcurrencyLoss, isDatabaseRefusal } from "./errors"
import { currentPayoutVerification } from "./payout-account"
import { agreementPayableOn } from "./payout-terms"
import { documentProblem } from "./state"

export type PayoutRefusal = { ok: false; status: 400 | 404 | 409 | 422; error: string; precondition: string; affordabilitySnapshot?: string }

export const refuse = (status: PayoutRefusal["status"], precondition: string, error: string): PayoutRefusal => ({ ok: false, status, error, precondition })
export const CHANGED = refuse(409, "changed", "The application changed while it was being disbursed; no loan was booked. Refresh and try again.")
const KYC_REFUSAL = refuse(422, "composite_kyc", "Cannot disburse: all four core KYC documents plus a current biometric or a recorded in-person verification are required before funds can move.")

/** A gate refused inside the transaction: thrown so that nothing it did stands, answered as its refusal. */
export class Refused extends Error {
  constructor(readonly refusal: PayoutRefusal) { super(refusal.error) }
}

const approvalRefusal = (reason: string): PayoutRefusal => {
  if (reason === "application_changed") return CHANGED
  if (reason === "kyc_changed") return KYC_REFUSAL
  return {
    ...refuse(422, "unchanged_affordability", "Cannot disburse: the borrower's identity or finances, the lender's policy or the approved terms changed after approval. Return the application to review and approve it again."),
    affordabilitySnapshot: reason,
  }
}

/** The refusal an error from the payout transaction amounts to; anything else is a fault and is thrown again. */
export function payoutRefusalFrom(error: unknown): PayoutRefusal {
  if (error instanceof Refused) return error.refusal
  if (isConcurrencyLoss(error)) return CHANGED
  if (isDatabaseRefusal(error)) return refuse(422, "database_guard", `Cannot disburse: ${databaseMessage(error)}`)
  throw error
}

export interface PayoutSubject { tenantId: string; applicationId: string; user: { id: string; email: string } }
export interface PayoutScope extends PayoutSubject { clientId: string; segregation: boolean }

/** Steps 1 to 3: what can refuse before any lock is taken. */
export async function payoutPreconditions(subject: PayoutSubject): Promise<PayoutRefusal | { ok: true; scope: PayoutScope }> {
  const { tenantId, applicationId, user } = subject
  const application = await prisma.loanApplication.findFirst({ where: { id: applicationId, tenantId }, include: { approvedBy: { select: { isSystem: true } } } })
  if (!application) return refuse(404, "not_found", "Application not found")
  if (application.disclosureRegime !== "KEY_FACTS") return refuse(409, "regime", "This application is disbursed through the credit agreement ceremony, not the key-facts route")
  if (application.status !== "APPROVED") return refuse(400, "status", "Only approved applications can be disbursed")
  const clientId = application.clientId
  if (!clientId) return refuse(409, "borrower", "A key-facts loan is made to a client")

  const segregation = await isSegregationOfDutiesRequired(tenantId)
  const segregationFacts = {
    ...application, approvedBySystem: application.approvedBy?.isSystem === true, approvalStepApproverIds: await approvalStepApproverIds(tenantId, applicationId),
  }
  const conflict = segregationOfDutiesConflict("disburse", user.id, segregationFacts)
  if (conflict && segregation) return refuse(422, "segregation_of_duties", SEGREGATION_OF_DUTIES_REFUSALS[conflict])

  // The credit committee's conditions (the database refuses the DISBURSED write too). With segregation of duties on, whoever cleared one is out
  // of the payout, and the payer is a different person from the approvers and clearers, not a second account of one.
  const conditions = await committeeConditionsRefusal(prisma, tenantId, applicationId)
  if (conditions) return refuse(409, "committee_conditions", `Cannot disburse: ${conditions}`)
  if (segregation) {
    const clearers = await clearedConditions(prisma, tenantId, applicationId)
    if (clearers.includes(user.id)) return refuse(422, "segregation_of_duties", CLEARER_REFUSAL)
    const controlled = await accountControlRefusal(prisma, { tenantId, makerIds: [...segregationOfDutiesMakers("disburse", segregationFacts), ...clearers], checkerId: user.id })
    if (controlled) return refuse(422, "segregation_of_duties", controlled)
  }

  const screening = await readBorrowerScreening(tenantId, { clientId, entityId: null })
  if (!screening.allowed) return refuse(422, "screening", `Cannot disburse: ${screening.message}`)
  return { ok: true, scope: { ...subject, clientId, segregation } }
}

type PayoutTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

const lockKycDocuments = (tx: AffordabilityEvidenceLockTransaction, tenantId: string, clientId: string) => tx.$queryRaw(Prisma.sql`
  SELECT "id" FROM "ClientDocument"
  WHERE "tenantId" = ${tenantId} AND "clientId" = ${clientId} AND (${KYC_AND_STATEMENT_DOCUMENTS})
  ORDER BY "id"
  FOR SHARE
`)

/** Steps 4 to 10, inside the caller's transaction. Throws Refused; the evidence it returns is what the loan is booked on. */
export async function payoutGates(tx: PayoutTransaction, scope: PayoutScope) {
  const { tenantId, applicationId, clientId, user } = scope
  const locked = await verifyLockedCurrentAffordabilityApproval(tx, { tenantId, applicationId })
  if (!locked.ok) throw new Refused(approvalRefusal(locked.reason))
  await lockKycDocuments(tx, tenantId, clientId)

  // From here on every gate reads this: the row as it stands under the locks, not the one read before them.
  const current = await tx.loanApplication.findFirst({ where: { id: applicationId, tenantId, status: "APPROVED", clientId }, include: { client: true } })
  if (!current?.client) throw new Refused(CHANGED)
  const { client } = current
  if (!(await lockedBorrowerScreeningAllows(tx, tenantId, { clientId, entityId: null }, current.approvedById ?? user.id, { providerRequired: true }))) {
    throw new Refused(refuse(422, "screening", "Cannot disburse: the borrower's screening no longer allows it."))
  }
  if (!current.agreementSignedAt) throw new Refused(refuse(422, "signed_agreement", "Cannot disburse: the borrower has not signed the loan agreement."))
  const problem = await documentProblem(applicationId, false, tx)
  if (problem) throw new Refused(refuse(422, "non_nca_documents", `Cannot disburse: ${problem}.`))

  const kyc = await readCompositeKycState(tx as unknown as CompositeKycReader, { tenantId, clientId, subject: client, existing: client, preserveVerifiedProvenance: true })
  if (client.kycStatus !== "VERIFIED" || !kyc.ok) throw new Refused(KYC_REFUSAL)
  if (dealerContactUnverified(client)) throw new Refused(refuse(409, "dealer_contact_unverified", DEALER_CONTACT_UNVERIFIED))

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
  if (scope.segregation) {
    const controlled = await accountControlRefusal(tx, { tenantId, makerIds: [verification.verifiedById], checkerId: user.id })
    if (controlled) throw new Refused(refuse(422, "payout_account_verification", controlled))
  }

  // The one instant of this payout: stamped under the locks, used for every judgement and row that follows.
  const at = new Date()
  if (!agreementPayableOn(new Date(locked.approval.calculator.startDate), at)) {
    throw new Refused(refuse(422, "schedule_expired", "Cannot disburse: the signed agreement could be paid out only on its start date. Return the application to review, approve it again and have the borrower sign the new agreement."))
  }
  // decide refuses a non-EFT key-facts approval and the DB freezes the method once approved, so this is the last backstop.
  if (current.repaymentMethod !== "EFT") throw new Refused(refuse(422, "repayment_method", "Cannot disburse: a key-facts loan is repaid by EFT (a debit order needs a mandate this route does not prepare)."))
  return { at, current, bank, approval: locked.approval, calculation: locked.calculation, statement: statement.evidence, verification, repaymentMethod: current.repaymentMethod }
}

/** The same gates, for the same person, booking nothing: whether the officer may make the transfer now. */
export async function keyFactsPayoutCheck(subject: PayoutSubject): Promise<{ ok: true } | PayoutRefusal> {
  const pre = await payoutPreconditions(subject)
  if (!pre.ok) return pre
  try {
    await prisma.$transaction((tx) => payoutGates(tx, pre.scope), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    return { ok: true }
  } catch (error) {
    return payoutRefusalFrom(error)
  }
}
