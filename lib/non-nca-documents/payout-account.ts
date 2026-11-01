import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { evaluateAvsGate } from "@/lib/avs"
import { lockAffordabilityApplicationEvidence, lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { avsSubjectFingerprint, type AvsSubjectClient } from "@/lib/compliance/avs-subject"
import { accountControlRefusal } from "@/lib/security/account-control"
import { isSegregationOfDutiesRequired, segregationOfDutiesMakers } from "@/lib/security/segregation-of-duties"
import { payoutVerificationNote, PAYOUT_VERIFICATION_NOTE_MAX, PAYOUT_VERIFICATION_NOTE_MIN, SECOND_PERSON_VERIFICATION_PROVIDER } from "./payout-terms"

/**
 * Second-person payout-account verification: what stands in for AVS on a key-facts loan, alongside the verified statement match. No AVS
 * provider covers Lesotho banks, so a staff member other than the one paying out confirms the account belongs to the borrower. It is an
 * AvsCheck row with this provider: bound to the application and to the account and identity on record (subjectFingerprint), so changing
 * either voids it exactly as it voids an AVS result, and covered by the client evidence lock the payout holds.
 */

/** The provider-reported checks of an AvsCheck: none, a person confirmed the account. */
const NOT_RETURNED = { accountActive: null, acceptsDebits: null, idNumberMatch: null, lastNameMatch: null, openThreeMonths: null }

export type RecordPayoutVerification = { ok: true; id: string } | { ok: false; status: 400 | 404 | 409 | 422; error: string }

export async function recordPayoutAccountVerification(args: {
  tenantId: string
  applicationId: string
  user: { id: string; email: string }
  note: unknown
}): Promise<RecordPayoutVerification> {
  const { tenantId, applicationId, user } = args
  const note = payoutVerificationNote(args.note)
  if (!note) return { ok: false, status: 400, error: `Say how the account was confirmed, in ${PAYOUT_VERIFICATION_NOTE_MIN} to ${PAYOUT_VERIFICATION_NOTE_MAX} characters.` }
  const row = await prisma.loanApplication.findFirst({ where: { id: applicationId, tenantId }, select: { clientId: true } })
  if (!row?.clientId) return { ok: false, status: 404, error: "Application not found" }
  const clientId = row.clientId
  return prisma.$transaction(async (tx) => {
    await lockAffordabilityApplicationEvidence(tx, { tenantId, applicationId })
    await lockAffordabilityClientEvidence(tx, { tenantId, clientId })
    const application = await tx.loanApplication.findFirst({
      where: { id: applicationId, tenantId },
      select: {
        status: true, disclosureRegime: true, inputStaffIds: true, approvedById: true, recklessLendingAssessedById: true, incomeVerifiedById: true, bureauOverrideById: true,
        approvedBy: { select: { isSystem: true } }, client: { select: { id: true, idNumber: true, firstName: true, lastName: true, bankName: true, bankBranchCode: true, bankAccountNumber: true, accountType: true } } },
    })
    if (!application?.client) return { ok: false, status: 404, error: "Application not found" }
    if (application.disclosureRegime !== "KEY_FACTS") return { ok: false, status: 409, error: "This application verifies its payout account through AVS" }
    if (application.status !== "APPROVED") return { ok: false, status: 409, error: "Only an approved application has a payout to verify" }
    // The confirmer is a second person, not a second account of someone who made or approved this application.
    if (await isSegregationOfDutiesRequired(tenantId, tx)) {
      const steps = await tx.approvalStep.findMany({ where: { tenantId, applicationId }, select: { approverId: true } })
      const facts = { ...application, approvedBySystem: application.approvedBy?.isSystem === true, approvalStepApproverIds: steps.map((s) => s.approverId) }
      const controlled = await accountControlRefusal(tx, { tenantId, makerIds: [...segregationOfDutiesMakers("disburse", facts), ...application.inputStaffIds], checkerId: user.id })
      if (controlled) return { ok: false, status: 409, error: controlled }
    }
    const { client } = application
    if (!client.bankName || !client.bankBranchCode || !client.bankAccountNumber || !client.accountType) {
      return { ok: false, status: 422, error: "The client's bank name, account number, branch code and account type must all be set before the account can be confirmed." }
    }
    const subjectFingerprint = avsSubjectFingerprint(client)
    const created = await tx.avsCheck.create({
      data: {
        tenantId, clientId, applicationId, subjectFingerprint, provider: SECOND_PERSON_VERIFICATION_PROVIDER, accountHolder: `${client.firstName} ${client.lastName}`,
        bankName: client.bankName, branchCode: client.bankBranchCode, accountNumber: client.bankAccountNumber, accountType: client.accountType,
        passed: true, checks: NOT_RETURNED, raw: { note }, checkedById: user.id,
      },
    })
    await logAuditStrict({
      tenantId, userId: user.id, userEmail: user.email, action: AuditAction.PAYOUT_ACCOUNT_VERIFIED, entity: "LoanApplication", entityId: applicationId,
      newValue: { avsCheckId: created.id, clientId, subjectFingerprint, provider: SECOND_PERSON_VERIFICATION_PROVIDER },
    }, tx)
    return { ok: true, id: created.id }
  })
}

export type PayoutVerification =
  | { ok: true; avsCheckId: string; verifiedById: string }
  | { ok: false; error: string }

/** The second person's confirmation of exactly this account, by someone other than the one paying out. Read under the payout's locks. */
export async function currentPayoutVerification(
  tx: Pick<typeof prisma, "avsCheck">,
  args: { tenantId: string; applicationId: string; client: AvsSubjectClient; disburserId: string },
): Promise<PayoutVerification> {
  const latest = await tx.avsCheck.findFirst({
    where: { tenantId: args.tenantId, clientId: args.client.id, applicationId: args.applicationId },
    orderBy: { createdAt: "desc" },
    select: { id: true, clientId: true, applicationId: true, subjectFingerprint: true, passed: true, provider: true, checkedById: true },
  })
  const current = evaluateAvsGate(latest, args.client, args.applicationId).ok && latest?.provider === SECOND_PERSON_VERIFICATION_PROVIDER
  if (!current || !latest?.checkedById) return { ok: false, error: "Cannot disburse: a second staff member must confirm the payout account on record before funds can move." }
  if (latest.checkedById === args.disburserId) return { ok: false, error: "Cannot disburse: the person who confirmed the payout account cannot also pay it out." }
  return { ok: true, avsCheckId: latest.id, verifiedById: latest.checkedById }
}
