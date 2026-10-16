import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { triggerNotification } from "@/lib/notifications"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { approvalBureauCheckWhere, bureauMaxAgeDays } from "@/lib/compliance/bureau"
import { evaluateBureauGate, nonOverridableBlock } from "@/lib/decision/bureau-gate"
import { simulatedBureauBlock } from "@/lib/decision/bureau-simulated"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { calculateLoan } from "@/lib/loan-calculator"
import { Prisma } from "@prisma/client"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  InvalidAffordabilityDebtError,
  affordabilityExpenseEvidenceNeedsMleJustification,
  affordabilityExpenseEvidenceIsIntact,
  bureauMonthlyObligations,
  createAffordabilityCalculatorEvidence,
  createBureauDecisionEvidence,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  normaliseAffordabilityDebts,
  readAffordabilityDebtInputs,
  readAffordabilitySnapshotStore,
  returnAffordabilityToDraft,
  returnAffordabilityToReview,
  sha256Text,
  totalAffordabilityDebt,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { verifySubmissionAffordabilitySnapshot } from "@/lib/affordability/submission-snapshot"
import { verifyLockedApprovalCandidate } from "@/lib/affordability/current-approval"
import { runBureauReviewCheck } from "@/lib/compliance/bureau-review"
import {
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { verifyAppliedCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { creditLifeOfferFindFirstArgs } from "@/lib/insurance/credit-life-offer"
import { creditLifeEvidenceSurvivesReturnToReview } from "@/lib/insurance/credit-life-return-to-review"
import { parseDeclineCategory } from "@/lib/applications/decline-category"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { declaredExpenses, payslipStateKey, statementSnapshot } from "@/lib/credit-checks/load-facts"
import {
  calculateCreditLifePremiumPeriods,
  createPasqBillingEvidence,
  type PasqBillingEvidence,
} from "@/lib/compliance/pasq"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"
import { borrowerScreeningGate, isScreeningRefusal, lockedBorrowerScreeningAllows } from "@/lib/screening/gate"
import { auditRefusal } from "@/lib/audit-refusals"

const MIN_BUREAU_OVERRIDE_REASON_LENGTH = 10

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await ctx.params

      let formData: FormData
      try {
        formData = await req.formData()
      } catch {
        return NextResponse.json(
          { error: "Expected multipart/form-data body" },
          { status: 400 }
        )
      }
      const action = formData.get("action") as string
      if (action === "return_to_draft" && !canDo(guard.user.role, "amend_application")) {
        return NextResponse.json({ error: "Your role cannot amend an application." }, { status: 403 })
      }
      const reason = formData.get("reason") as string
      const bureauOverrideReason = ((formData.get("bureauOverrideReason") as string | null) ?? "").trim() || null
      const repaymentMethodValue = formData.get("repaymentMethod")
      const repaymentMethod =
        repaymentMethodValue === "EFT" || repaymentMethodValue === "DEBIT_ORDER"
          ? repaymentMethodValue
          : null

      const application = await prisma.loanApplication.findUnique({
        where: { id, tenantId: tenant.id },
        include: {
          product: { select: { interestRatePm: true, productType: true, interestModel: true, initiationFeeModel: true, initiationFeePct: true, initiationFeeMax: true, monthlyServiceFee: true } },
          loan: { select: { id: true } },
          client: {
            select: {
              id: true,
              idNumber: true,
              firstName: true,
              lastName: true,
              gender: true,
              dateOfBirth: true,
              kycStatus: true,
              kycVerifiedAt: true,
              kycVerifiedById: true,
              kycVerificationMethod: true,
              kycManualRejectionActive: true,
              kycManualRejectionAt: true,
              kycManualRejectionById: true,
              kycManualRejectionReason: true,
              kycManualRejectionResolvedAt: true,
              kycManualRejectionResolvedById: true,
              kycManualRejectionResolutionReason: true,
              // Needed by the DEBIT_ORDER approval bar below. An OTHER account
              // cannot carry a debit order, and approving one onto it dead-ends
              // at mandate preparation with a misleading error.
              accountType: true,
              grossMonthlyIncome: true,
              monthlyIncome: true,
              monthlyExpenses: true,
              expenseBreakdown: {
                select: {
                  id: true,
                  updatedAt: true,
                  housing: true,
                  transport: true,
                  food: true,
                  education: true,
                  insurance: true,
                  clothing: true,
                  entertainment: true,
                  medical: true,
                  other: true,
                  belowMleJustification: true,
                },
              },
              debtObligations: {
                select: {
                  id: true,
                  creditProvider: true,
                  accountType: true,
                  outstandingBalance: true,
                  monthlyInstalment: true,
                  notes: true,
                },
              },
            },
          },
        },
      })

      if (!application) {
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      }
      // Consumer credit decision (affordability, bureau, PASQ); asset finance decides elsewhere.
      if (!hasClientBorrower(application)) {
        return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
      }

      if (action === "return_to_review") {
        const returnReason = reason?.trim() ?? ""
        if (application.status !== "APPROVED" || application.loan) {
          return NextResponse.json(
            { error: "Only an approved, undisbursed application can be returned to review" },
            { status: 400 },
          )
        }
        if (returnReason.length < 10) {
          return NextResponse.json(
            { error: "Return-to-review reason must be at least 10 characters." },
            { status: 400 },
          )
        }

        const returnedAt = new Date()
        const bureauReviewGeneration = randomUUID()
        const signatureArtifact = application.agreementSignatureData
        const reopened = await prisma.$transaction(async (tx) => {
          const changed = await tx.loanApplication.updateMany({
            where: {
              id,
              tenantId: tenant.id,
              status: "APPROVED",
              updatedAt: application.updatedAt,
            },
            data: {
              status: "UNDER_REVIEW",
              repaymentMethod: null,
              assignedToId: guard.user.id,
              approvedById: null,
              approvedAt: null,
              approvedAmount: null,
              approvedTermDays: null,
              approvedRate: null,
              decisionReason: null,
              affordabilityResult: returnAffordabilityToReview(
                application.affordabilityResult,
              ) as unknown as Prisma.InputJsonValue,
              bureauOverrideReason: null,
              bureauOverrideById: null,
              bureauOverrideAt: null,
              bureauReviewGeneration,
              recklessLendingAssessed: false,
              recklessLendingAssessedById: null,
              recklessLendingAssessedAt: null,
              pasqAcknowledgedAt: null,
              pasqAcknowledgedBy: null,
              pasqAcknowledgedSha256: null,
              pasqVersion: null,
              pasqGeneratedAt: null,
              pasqDocumentId: null,
              pasqDocumentSha256: null,
              pasqEvidence: Prisma.DbNull,
              pasqEvidenceSha256: null,
              approvedPasqDocumentSha256: null,
              clientAffordabilityDeclaredAt: null,
              agreementGeneratedAt: null,
              agreementDocumentId: null,
              agreementDocumentSha256: null,
              agreementSignedAt: null,
              agreementSignedMethod: null,
              agreementSignedByIp: null,
              agreementSignedByUserId: null,
              agreementSignatureData: null,
              agreementCountersignedAt: null,
              agreementCountersignedById: null,
              agreementCountersignedByName: null,
              agreementCountersignedByEmail: null,
              agreementCountersignatureData: null,
              agreementCountersignatureSha256: null,
              agreementCountersignatureEnvelopeSha256: null,
              agreementCountersignedDocumentSha256: null,
              // The EXECUTED artifact belongs to the agreement lifecycle being
              // torn down. Leaving it set makes the application permanently
              // un-countersignable: the countersign preflight refuses on it, and
              // its updateMany predicate requires it to be null. That blocks
              // disbursement with no in-app remedy.
              agreementExecutedDocumentId: null,
              agreementExecutedDocumentSha256: null,
              // Same reason, for the RETURNED packet: a binding left pointing at
              // a signed packet after its agreement lifecycle is torn down
              // outlives the truth it recorded. The card would surface it again
              // the moment a new agreement is generated.
              signedPacketDocumentId: null,
              signedPacketDocumentSha256: null,
              debitMandatePreparedAt: null,
              debitMandateReference: null,
              debitMandateDraftSha256: null,
              debitMandateEvidence: Prisma.DbNull,
              debitMandateEvidenceSha256: null,
              debitMandateSignedAt: null,
              debitMandateSignedMethod: null,
              debitMandateSignedByIp: null,
              debitMandateSignatureData: null,
              debitMandateSignatureSha256: null,
              debitMandateDocumentId: null,
              debitMandateDocumentSha256: null,
            },
          })
          if (changed.count !== 1) return false

          // The PASQ approval guard requires the credit-life offer bound into
          // the approved quotation to remain unchanged during the guarded
          // APPROVED -> UNDER_REVIEW transition, so any change to that offer
          // has to happen after the row is already under review.
          //
          // Only clear what the offer has actually invalidated. This transition
          // leaves appliedAmount and appliedTermDays untouched, and those plus
          // the offer identity are the whole of what the disclosure hash binds
          // — so an election matching the current offer is still exactly true.
          // Clearing it regardless forced a recapture only the draft wizard can
          // do, and reaching the wizard also discards the bureau enquiry, so
          // correcting one unrelated field cost the consumer a second bureau
          // footprint to re-record byte-identical evidence.
          const currentCreditLifeProduct = await tx.insuranceProduct.findFirst(
            creditLifeOfferFindFirstArgs(tenant.id),
          )
          const currentCreditLifeOffer =
            currentCreditLifeProduct
            && currentCreditLifeProduct.insurerId
            && currentCreditLifeProduct.insurer
            && currentCreditLifeProduct.name.trim() !== ""
            && currentCreditLifeProduct.insurer.name.trim() !== ""
              ? {
                  productId: currentCreditLifeProduct.id,
                  productName: currentCreditLifeProduct.name,
                  insurerId: currentCreditLifeProduct.insurerId,
                  insurerName: currentCreditLifeProduct.insurer.name,
                }
              : null
          // A product row exists but cannot be presented — blank product or
          // insurer name. This lookup is ORDERED and takes the first row; the
          // approval guard's own re-check is an unordered EXISTS that requires
          // non-blank names, so it can still find a usable offer this missed.
          // Retaining here would hand that guard an election it then rejects,
          // at approval, where staff have no way to act on it. Fail closed.
          const creditLifeRetention =
            currentCreditLifeProduct && !currentCreditLifeOffer
              ? { retain: false as const, reason: "offer_changed" as const }
              : creditLifeEvidenceSurvivesReturnToReview(
                  application,
                  {
                    principalCents: application.appliedAmount,
                    termDays: application.appliedTermDays,
                  },
                  currentCreditLifeOffer,
                )
          if (!creditLifeRetention.retain) {
            const clearedCreditLife = await tx.loanApplication.updateMany({
              where: {
                id,
                tenantId: tenant.id,
                status: "UNDER_REVIEW",
              },
              data: {
                creditLifeElection: null,
                creditLifeProductId: null,
                creditLifeProductName: null,
                creditLifeInsurerId: null,
                creditLifeInsurerName: null,
                creditLifeMonthlyPremiumCents: null,
                creditLifeDisclosureVersion: null,
                creditLifeDisclosureSha256: null,
                creditLifeDisclosureAcknowledgedAt: null,
                creditLifeDisclosureAcknowledgedBy: null,
              },
            })
            if (clearedCreditLife.count !== 1) {
              throw new Error("Failed to clear stale credit-life evidence after returning to review")
            }
          }

          // §3 M: the cleared PASQ binding leaves the quotation document
          // orphaned but visible, indistinguishable from a current one.
          // Retire it in the same transaction so "which quotation did this
          // consumer receive?" always has one answer.
          if (application.pasqDocumentId) {
            await tx.clientDocument.updateMany({
              where: {
                id: application.pasqDocumentId,
                tenantId: tenant.id,
                clientId: application.clientId,
                docType: "FORM_20_PRE_AGREEMENT",
                deletedAt: null,
              },
              data: {
                deletedAt: returnedAt,
                deletedByType: "staff",
                deletedById: guard.user.id,
              },
            })
          }

          // Same reasoning for the EXECUTED agreement: it evidences a contract
          // this return-to-review has just withdrawn. Left visible it tells the
          // consumer they have a signed credit agreement for a loan that is
          // being re-papered — and the locked-statutory guard makes it
          // undeletable afterwards, so it must be retired HERE or never.
          if (application.agreementExecutedDocumentId) {
            await tx.clientDocument.updateMany({
              where: {
                id: application.agreementExecutedDocumentId,
                tenantId: tenant.id,
                clientId: application.clientId,
                docType: "EXECUTED_CREDIT_AGREEMENT",
                deletedAt: null,
              },
              data: {
                deletedAt: returnedAt,
                deletedByType: "staff",
                deletedById: guard.user.id,
              },
            })
          }

          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.APPLICATION_RETURNED_TO_REVIEW,
              entity: "LoanApplication",
              entityId: id,
              oldValue: {
                status: application.status,
                repaymentMethod: application.repaymentMethod,
                approvedAt: application.approvedAt?.toISOString() ?? null,
                approvedById: application.approvedById,
                agreementGeneratedAt: application.agreementGeneratedAt?.toISOString() ?? null,
                agreementDocumentId: application.agreementDocumentId,
                agreementDocumentSha256: application.agreementDocumentSha256,
                agreementSignedAt: application.agreementSignedAt?.toISOString() ?? null,
                agreementSignedMethod: application.agreementSignedMethod,
                agreementSignedByIp: application.agreementSignedByIp,
                agreementSignedByUserId: application.agreementSignedByUserId,
                agreementSignaturePresent: signatureArtifact !== null,
                agreementSignatureSha256: signatureArtifact
                  ? sha256Text(signatureArtifact)
                  : null,
                agreementCountersignedAt: application.agreementCountersignedAt?.toISOString() ?? null,
                agreementCountersignedById: application.agreementCountersignedById,
                agreementCountersignedByName: application.agreementCountersignedByName,
                agreementCountersignedByEmail: application.agreementCountersignedByEmail,
                agreementCountersignatureSha256: application.agreementCountersignatureSha256,
                agreementCountersignatureEnvelopeSha256:
                  application.agreementCountersignatureEnvelopeSha256,
                agreementCountersignedDocumentSha256: application.agreementCountersignedDocumentSha256,
                pasqAcknowledgedAt: application.pasqAcknowledgedAt?.toISOString() ?? null,
                pasqDocumentId: application.pasqDocumentId,
                pasqDocumentSha256: application.pasqDocumentSha256,
                pasqEvidenceSha256: application.pasqEvidenceSha256,
                approvedPasqDocumentSha256: application.approvedPasqDocumentSha256,
                clientAffordabilityDeclaredAt: application.clientAffordabilityDeclaredAt?.toISOString() ?? null,
              },
              newValue: {
                status: "UNDER_REVIEW",
                reason: returnReason,
                returnedAt: returnedAt.toISOString(),
                bureauReviewGeneration,
                priorApprovalArchived: true,
                agreementInvalidated: application.agreementGeneratedAt !== null,
                agreementDocumentRetained: application.agreementDocumentId !== null,
                // The audit log is the register auditors actually query. Without
                // this it records a return-to-review that names the PASQ and the
                // unsigned agreement and is silent about the one document that
                // carried BOTH signatures — which this transaction just retired.
                executedAgreementRetired: application.agreementExecutedDocumentId !== null,
                executedAgreementDocumentId: application.agreementExecutedDocumentId,
                executedAgreementDocumentSha256: application.agreementExecutedDocumentSha256,
                pasqInvalidated: application.pasqDocumentId !== null,
                pasqDocumentRetained: application.pasqDocumentId !== null,
                // Whether the consumer still has to be asked about credit life
                // again is the difference between a one-field correction and a
                // second bureau enquiry, so name the outcome and its reason.
                creditLifeEvidence: creditLifeRetention.retain
                  ? "retained"
                  : `cleared:${creditLifeRetention.reason}`,
                // This transition nulls every other consumer acknowledgement on
                // the row, and oldValue names each one. A retained credit-life
                // election is then the only declaration crossing the boundary,
                // so identify it: "retained" alone leaves an NCR query asking
                // which election an agreement was entered into on, with an
                // acknowledgedAt that predates the whole withdrawn lifecycle.
                ...(creditLifeRetention.retain && {
                  retainedCreditLifeDisclosureSha256: application.creditLifeDisclosureSha256,
                  retainedCreditLifeDisclosureVersion: application.creditLifeDisclosureVersion,
                  retainedCreditLifeElection: application.creditLifeElection,
                  retainedCreditLifeAcknowledgedAt:
                    application.creditLifeDisclosureAcknowledgedAt?.toISOString() ?? null,
                  retainedCreditLifeAcknowledgedBy: application.creditLifeDisclosureAcknowledgedBy,
                }),
              },
            },
          })
          return true
        })
        if (!reopened) {
          return NextResponse.json(
            { error: "Application changed before it could be returned to review; refresh and try again." },
            { status: 409 },
          )
        }

        runBureauReviewCheck({
          tenantId: tenant.id,
          applicationId: id,
          clientId: application.clientId,
          reviewGeneration: bureauReviewGeneration,
        }).catch((error) => {
          console.error("[decide] reopened-review bureau check failed:", error)
        })

        return NextResponse.json({ ok: true, status: "UNDER_REVIEW" })
      }

      if (action === "return_to_draft") {
        const returnReason = reason?.trim() ?? ""
        if (application.status !== "UNDER_REVIEW") {
          return NextResponse.json(
            { error: "Only an application under review can be returned to draft" },
            { status: 400 },
          )
        }
        if (returnReason.length < 10) {
          return NextResponse.json(
            { error: "Return-to-draft reason must be at least 10 characters." },
            { status: 400 },
          )
        }

        const returnedAt = new Date()
        const returned = await prisma.$transaction(async (tx) => {
          const changed = await tx.loanApplication.updateMany({
            where: {
              id,
              tenantId: tenant.id,
              status: "UNDER_REVIEW",
              updatedAt: application.updatedAt,
            },
            data: {
              status: "DRAFT",
              submittedAt: null,
              assignedToId: null,
              decisionReason: null,
              netDisposableIncome: null,
              affordabilityNDI: null,
              affordabilityResult: returnAffordabilityToDraft(
                application.affordabilityResult,
              ) as unknown as Prisma.InputJsonValue,
              bureauOverrideReason: null,
              bureauOverrideById: null,
              bureauOverrideAt: null,
              bureauReviewGeneration: null,
              recklessLendingAssessed: false,
              recklessLendingAssessedById: null,
              recklessLendingAssessedAt: null,
              pasqAcknowledgedAt: null,
              pasqAcknowledgedBy: null,
              pasqAcknowledgedSha256: null,
              pasqVersion: null,
              pasqGeneratedAt: null,
              pasqDocumentId: null,
              pasqDocumentSha256: null,
              pasqEvidence: Prisma.DbNull,
              pasqEvidenceSha256: null,
              approvedPasqDocumentSha256: null,
              clientAffordabilityDeclaredAt: null,
              creditLifeElection: null,
              creditLifeProductId: null,
              creditLifeProductName: null,
              creditLifeInsurerId: null,
              creditLifeInsurerName: null,
              creditLifeMonthlyPremiumCents: null,
              creditLifeDisclosureVersion: null,
              creditLifeDisclosureSha256: null,
              creditLifeDisclosureAcknowledgedAt: null,
              creditLifeDisclosureAcknowledgedBy: null,
              agreementGeneratedAt: null,
              agreementDocumentId: null,
              agreementDocumentSha256: null,
              agreementSignedAt: null,
              agreementSignedMethod: null,
              agreementSignedByIp: null,
              agreementSignedByUserId: null,
              agreementSignatureData: null,
              agreementCountersignedAt: null,
              agreementCountersignedById: null,
              agreementCountersignedByName: null,
              agreementCountersignedByEmail: null,
              agreementCountersignatureData: null,
              agreementCountersignatureSha256: null,
              agreementCountersignatureEnvelopeSha256: null,
              agreementCountersignedDocumentSha256: null,
              // The EXECUTED artifact belongs to the agreement lifecycle being
              // torn down. Leaving it set makes the application permanently
              // un-countersignable: the countersign preflight refuses on it, and
              // its updateMany predicate requires it to be null. That blocks
              // disbursement with no in-app remedy.
              agreementExecutedDocumentId: null,
              agreementExecutedDocumentSha256: null,
              // Same reason, for the RETURNED packet: a binding left pointing at
              // a signed packet after its agreement lifecycle is torn down
              // outlives the truth it recorded. The card would surface it again
              // the moment a new agreement is generated.
              signedPacketDocumentId: null,
              signedPacketDocumentSha256: null,
              debitMandatePreparedAt: null,
              debitMandateReference: null,
              debitMandateDraftSha256: null,
              debitMandateEvidence: Prisma.DbNull,
              debitMandateEvidenceSha256: null,
              debitMandateSignedAt: null,
              debitMandateSignedMethod: null,
              debitMandateSignedByIp: null,
              debitMandateSignatureData: null,
              debitMandateSignatureSha256: null,
              debitMandateDocumentId: null,
              debitMandateDocumentSha256: null,
            },
          })
          if (changed.count !== 1) return false

          // §3 M: the cleared PASQ binding leaves the quotation document
          // orphaned but visible, indistinguishable from a current one.
          // Retire it in the same transaction so "which quotation did this
          // consumer receive?" always has one answer.
          if (application.pasqDocumentId) {
            await tx.clientDocument.updateMany({
              where: {
                id: application.pasqDocumentId,
                tenantId: tenant.id,
                clientId: application.clientId,
                docType: "FORM_20_PRE_AGREEMENT",
                deletedAt: null,
              },
              data: {
                deletedAt: returnedAt,
                deletedByType: "staff",
                deletedById: guard.user.id,
              },
            })
          }

          // Same reasoning for the EXECUTED agreement: it evidences a contract
          // this return-to-review has just withdrawn. Left visible it tells the
          // consumer they have a signed credit agreement for a loan that is
          // being re-papered — and the locked-statutory guard makes it
          // undeletable afterwards, so it must be retired HERE or never.
          if (application.agreementExecutedDocumentId) {
            await tx.clientDocument.updateMany({
              where: {
                id: application.agreementExecutedDocumentId,
                tenantId: tenant.id,
                clientId: application.clientId,
                docType: "EXECUTED_CREDIT_AGREEMENT",
                deletedAt: null,
              },
              data: {
                deletedAt: returnedAt,
                deletedByType: "staff",
                deletedById: guard.user.id,
              },
            })
          }

          const priorSubmission = readAffordabilitySnapshotStore(
            application.affordabilityResult,
          ).submission
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.APPLICATION_RETURNED_TO_DRAFT,
              entity: "LoanApplication",
              entityId: id,
              oldValue: {
                status: application.status,
                submittedAt: application.submittedAt?.toISOString() ?? null,
                submissionEvidencePresent: priorSubmission !== undefined,
                submissionDecisionFingerprint: priorSubmission?.decisionFingerprint ?? null,
              },
              newValue: {
                status: "DRAFT",
                reason: returnReason,
                returnedAt: returnedAt.toISOString(),
                complianceEvidenceReset: true,
                priorEvidencePreserved: application.affordabilityResult !== null,
                // Same reasoning as the return-to-review audit above: this
                // transaction retires the document carrying BOTH signatures, so
                // the register auditors query must name it.
                executedAgreementRetired: application.agreementExecutedDocumentId !== null,
                executedAgreementDocumentId: application.agreementExecutedDocumentId,
                executedAgreementDocumentSha256: application.agreementExecutedDocumentSha256,
              },
            },
          })
          return true
        })
        if (!returned) {
          return NextResponse.json(
            { error: "Application changed before it could be returned to draft; refresh and try again." },
            { status: 409 },
          )
        }

        return NextResponse.json({ ok: true, status: "DRAFT" })
      }

      if (application.status !== "UNDER_REVIEW") {
        return NextResponse.json(
          { error: "Application is not under review" },
          { status: 400 }
        )
      }

      if (action === "approve") {
        if (!repaymentMethod) {
          return NextResponse.json(
            {
              error: "Select EFT or debit order as the repayment method.",
              repaymentMethod: "required",
            },
            { status: 400 },
          )
        }
        // An OTHER account cannot carry a debit order: the Netcash AVS wire has
        // only "Current" and "Savings" to send, so `requireDebitMandateBankDetails`
        // refuses it and no mandate can ever be prepared.
        //
        // Refusing at APPROVAL rather than leaving it to mandate preparation is
        // the point. Without this, an OTHER client is approved happily, the
        // consumer is sent a mandate link, and the flow dead-ends at "Complete
        // on-file banking details are required before generating a debit
        // mandate" — for a client whose details ARE complete and are merely
        // OTHER. The error names the wrong problem and there is no staff-side
        // remedy on that screen. Fail here, where the operator can still pick
        // EFT or correct the account type.
        if (
          repaymentMethod === "DEBIT_ORDER"
          && application.client.accountType === "OTHER"
        ) {
          return NextResponse.json(
            {
              error: "This client's account type is recorded as Other, which cannot carry a debit order. Approve for EFT, or set a cheque or savings account type first.",
              repaymentMethod: "account_type_not_debit_orderable",
            },
            { status: 400 },
          )
        }
        if (
          bureauOverrideReason &&
          bureauOverrideReason.length < MIN_BUREAU_OVERRIDE_REASON_LENGTH
        ) {
          return NextResponse.json(
            {
              error: `Bureau override reason must be at least ${MIN_BUREAU_OVERRIDE_REASON_LENGTH} characters.`,
              bureauOverrideValidation: "reason_too_short",
            },
            { status: 400 },
          )
        }

        // One shared rule, three enforcing gates — see
        // `verifySubmissionAffordabilitySnapshot`.
        const submissionCheck = verifySubmissionAffordabilitySnapshot(application)
        if (!submissionCheck.ok && submissionCheck.reason === "submission_missing") {
          return NextResponse.json(
            {
              error: "Approval blocked: immutable submission affordability evidence is missing. Return the application to draft and submit it again before approval.",
              affordabilitySnapshot: "submission_missing",
            },
            { status: 422 },
          )
        }
        if (!submissionCheck.ok) {
          return NextResponse.json(
            {
              error: "Approval blocked: immutable submission affordability evidence is invalid or has been altered. Return the application to draft and submit it again before approval.",
              affordabilitySnapshot: "submission_changed",
            },
            { status: 422 },
          )
        }

        const currentKyc = await readCompositeKycState(
          prisma as unknown as CompositeKycReader,
          {
            tenantId: tenant.id,
            clientId: application.clientId,
            subject: application.client,
            existing: application.client,
            preserveVerifiedProvenance: true,
          },
        )
        // Origination-grade: approval does not require biometrics. Payout
        // does — disburse/route.ts still requires the strict `ok`.
        if (!currentKyc.okForOrigination && currentKyc.biometricAwaitingIdVerification) {
          // The selfie matched the client's first ID copy before staff
          // verified it; verifying that copy is the remedy.
          return NextResponse.json(
            {
              error: "The client's ID copy must be verified before approval; the selfie already matched it.",
              kycStatus: currentKyc.state.kycStatus,
              missingDocs: currentKyc.missingCoreDocuments,
              biometricEvidence: currentKyc.biometricEvidence,
              idCopyAwaitingVerification: true,
              documentId: currentKyc.latestSelfieId,
              idDocumentId: currentKyc.awaitingIdDocumentId,
            },
            { status: 422 }
          )
        }
        if (!currentKyc.okForOrigination) {
          return NextResponse.json(
            {
              error: "KYC not complete.",
              kycStatus: currentKyc.state.kycStatus,
              missingDocs: currentKyc.missingCoreDocuments,
              biometricEvidence: currentKyc.biometricEvidence,
            },
            { status: 422 }
          )
        }

        const creditLifeDisclosure = verifyAppliedCreditLifeDisclosure(application)
        if (!creditLifeDisclosure.ok) {
          return NextResponse.json(
            {
              error: "Approval requires an intact credit-life election and exact-premium disclosure captured before the PASQ.",
              missingComplianceEvidence: ["credit-life election"],
              creditLifeEvidence: creditLifeDisclosure.reason,
            },
            { status: 422 },
          )
        }

        const missingComplianceEvidence = [
          ...(!application.clientAffordabilityDeclaredAt
            ? ["client affordability declaration"]
            : []),
          ...(!application.recklessLendingAssessed ||
            !application.recklessLendingAssessedAt ||
            !application.recklessLendingAssessedById
            ? ["reckless-lending assessment"]
            : []),
        ]
        if (missingComplianceEvidence.length > 0) {
          return NextResponse.json(
            {
              error: `Approval requires fresh compliance evidence: ${missingComplianceEvidence.join(", ")}.`,
              missingComplianceEvidence,
            },
            { status: 422 },
          )
        }

        // Bureau gate — check latest bureau result against tenant thresholds.
        // NCA s.81 requires the credit assessment to be current; staleness
        // window lives in `lib/compliance/bureau.ts` so /decide and /disburse
        // can never drift apart. The tenant's window is read first: it bounds the query.
        const tenantConfig = await prisma.tenantConfig.findFirst({
          where: { tenantId: tenant.id },
          select: { bureauMinScore: true, bureauBlockAdverse: true, ndiBufferPct: true, bureauMaxAgeDays: true },
        })
        // Only approval bureaus (Sigma band, hard-stop flags) drive approval — a
        // legacy TransUnion row is a different score scale and lacks the flags.
        const bureauCheck = application.bureauReviewGeneration
          ? await prisma.creditBureauCheck.findFirst({
              where: approvalBureauCheckWhere({
                tenantId: tenant.id,
                applicationId: id,
                clientId: application.clientId,
                reviewGeneration: application.bureauReviewGeneration,
                maxAgeDays: bureauMaxAgeDays(tenantConfig),
              }),
              orderBy: { createdAt: "desc" },
            })
          : null

        // Deceased is a NON-OVERRIDABLE hard stop — an audited override reason
        // cannot approve a consumer the bureau reports as deceased (owner
        // decision). Checked before the override bypass below.
        const hardStop = nonOverridableBlock({ deceased: bureauCheck?.deceased ?? false })
        if (hardStop.blocked) {
          return NextResponse.json(
            {
              error: `Approval blocked: ${hardStop.reason} This cannot be overridden.`,
              deceasedBlock: true,
              requiresOverride: false,
            },
            { status: 422 },
          )
        }

        // A simulated check is fabricated evidence wherever this deployment
        // forbids Experian simulation; an override reason cannot approve on it.
        const simulatedStop = simulatedBureauBlock(bureauCheck)
        if (simulatedStop.blocked) {
          return NextResponse.json(
            {
              error: `Approval blocked: ${simulatedStop.reason} This cannot be overridden.`,
              simulatedBureauBlock: true,
              requiresOverride: false,
            },
            { status: 422 },
          )
        }

        // NCA s.81 (reckless lending) requires a credit assessment before
        // entering into a credit agreement. The earlier review path runs the
        // bureau check, but it can be skipped (missing POPIA consent), fail
        // (integration error), or have gone stale (>90 days). Refuse to
        // approve without either a successful current pull or a documented,
        // audited override persisted to `recklessLendingNote`.
        if (!bureauCheck && !bureauOverrideReason) {
          return NextResponse.json(
            {
              error: "Bureau enquiry required: cannot approve without a current credit bureau check.",
              bureauMissing: true,
              requiresOverride: true,
            },
            { status: 422 }
          )
        }

        // A reasoned bureau override may bypass only the bureau gate. It must
        // never bypass affordability, and it must not erase the financial
        // calculation. Persist the exact approval inputs so the exception stays
        // reviewable and every downstream gate can detect master-data drift.
        if (bureauCheck && !bureauOverrideReason) {
          const bureau = evaluateBureauGate(
            {
              score: bureauCheck.score,
              unscoreable: bureauCheck.unscoreable,
              hasAdverse: bureauCheck.hasAdverse,
              deceased: bureauCheck.deceased,
              underDebtReview: bureauCheck.underDebtReview,
              hasJudgement: bureauCheck.hasJudgement,
              hasNotice: bureauCheck.hasNotice,
              obligations: bureauCheck.obligations,
              provider: bureauCheck.provider,
            },
            { bureauMinScore: tenantConfig?.bureauMinScore ?? 450, bureauBlockAdverse: tenantConfig?.bureauBlockAdverse ?? false },
          )
          if (bureau.blocked) {
            return NextResponse.json(
              { error: `Bureau risk gate: ${bureau.reason}`, requiresOverride: true, requiresCalibration: bureau.requiresCalibration ?? false },
              { status: 422 },
            )
          }

        }

        const approvalPrincipal = application.appliedAmount
        const approvalTermDays = application.appliedTermDays
        const decisionAt = new Date()
        // NCA s.92(1) forbids ENTERING INTO the agreement without a prior
        // quotation — it says nothing about the internal credit decision.
        // Approval therefore anchors its own schedule and no longer waits on a
        // PASQ; the PASQ is minted and acknowledged at the signing ceremony,
        // immediately before the agreement is signed. See app/api/applications
        // /[id]/pasq/route.ts, which now runs against an APPROVED application.
        const calculationStartDate = decisionAt
        const loanCalc = calculateLoan({
          principal: approvalPrincipal,
          termDays: approvalTermDays,
          interestRatePm: application.product.interestRatePm,
          productType: application.product.productType,
          interestModel: application.product.interestModel as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
          initiationFeeModel: application.product.initiationFeeModel,
          initiationFeePct: application.product.initiationFeePct,
          initiationFeeMax: application.product.initiationFeeMax,
          monthlyServiceFee: application.product.monthlyServiceFee,
          initiationFeePayment: application.initiationFeePayment,
        }, calculationStartDate)
        const approvalCalculatorEvidence = createAffordabilityCalculatorEvidence(
          loanCalc,
          calculationStartDate,
        )
        const expenseEvidence = createAffordabilityExpenseEvidence(application.client)
        if (
          affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)
        ) {
          return NextResponse.json(
            {
              error: "Approval blocked: declared living expenses are below the Regulation 23A minimum and require a documented justification on the client expense record.",
              mleJustificationMissing: true,
              minimumLivingExpenses: expenseEvidence.mle.minimumExpenseCents,
              declaredLivingExpenses: expenseEvidence.statedMonthlyExpensesCents,
            },
            { status: 422 },
          )
        }
        if (!affordabilityExpenseEvidenceIsIntact(expenseEvidence)) {
          return NextResponse.json(
            {
              error: "Approval blocked: the client's scalar and itemised expense evidence is incomplete or inconsistent. Repair the client financial record and reassess the application.",
              expenseEvidenceInvalid: true,
            },
            { status: 422 },
          )
        }
        // The affordability gate must test the instalment the consumer will
        // actually be billed, which includes any bundled credit-life premium.
        // That figure used to be read off the PASQ; with the PASQ deferred to
        // the ceremony it is derived from the SAME billing helper the PASQ
        // itself uses, so the approved instalment and the quoted instalment are
        // produced by one code path and cannot silently diverge.
        let approvalBilling: PasqBillingEvidence
        try {
          approvalBilling = createPasqBillingEvidence({
            calculator: approvalCalculatorEvidence,
            election: creditLifeDisclosure.evidence.election,
            // No-offer disclosures carry DECLINED + premium exactly 0; the
            // billing helper's validation branches on `offered` and REJECTS a
            // zero premium when it defaults to true. Omitting this made every
            // no-offer application unapprovable — the same failure that a zero
            // premium causes anywhere else the helper runs.
            offered: creditLifeDisclosure.evidence.offered,
            monthlyPremiumCents: creditLifeDisclosure.evidence.monthlyPremiumCents,
            premiumPeriods: calculateCreditLifePremiumPeriods(
              approvalCalculatorEvidence,
              approvalTermDays,
            ),
          })
        } catch {
          return NextResponse.json(
            {
              error: "Approval blocked: the credit-life billing schedule is outside the supported range for this pricing.",
              creditLifeEvidence: "billing_invalid",
            },
            { status: 422 },
          )
        }
        const instalment = approvalBilling.recurringPaymentCents
        const creditLifePremiumCents = instalment - loanCalc.monthlyInstalment
        let applicationDebts: ReturnType<typeof normaliseAffordabilityDebts>
        let clientDebts: ReturnType<typeof normaliseAffordabilityDebts>
        let applicationDebtCents: number
        let clientDebtCents: number
        try {
          applicationDebts = normaliseAffordabilityDebts(
            readAffordabilityDebtInputs(application.existingDebtObligations),
          )
          clientDebts = normaliseAffordabilityDebts(application.client.debtObligations)
          applicationDebtCents = totalAffordabilityDebt(applicationDebts)
          clientDebtCents = totalAffordabilityDebt(clientDebts)
        } catch (error) {
          if (error instanceof InvalidAffordabilityDebtError) {
            return NextResponse.json(
              {
                error: "Approval blocked: declared debt evidence is invalid or outside the supported monetary range. Repair and reassess the application.",
                debtEvidenceInvalid: true,
              },
              { status: 422 },
            )
          }
          throw error
        }
        const declaredDebt = Math.max(applicationDebtCents, clientDebtCents)
        const bureauObligations = bureauMonthlyObligations(bureauCheck?.obligations)
        const ndiBufferPct = tenantConfig?.ndiBufferPct ?? 110
        const bureauMinScore = tenantConfig?.bureauMinScore ?? 450
        const bureauBlockAdverse = tenantConfig?.bureauBlockAdverse ?? false
        const affordabilityInputs = {
          monthlyIncomeCents: application.client.monthlyIncome,
          monthlyExpensesCents: application.client.monthlyExpenses,
          applicationDebtCents,
          clientDebtCents,
          declaredDebtCents: declaredDebt,
          bureauObligationsCents: bureauObligations,
          proposedInstalmentCents: instalment,
          creditLifePremiumCents,
          principalCents: approvalPrincipal,
          termDays: approvalTermDays,
          productId: application.productId,
          interestRatePm: application.product.interestRatePm,
          productType: application.product.productType,
          interestModel: application.product.interestModel as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
          initiationFeeModel: application.product.initiationFeeModel,
          initiationFeePct: application.product.initiationFeePct,
          initiationFeeMaxCents: application.product.initiationFeeMax,
          monthlyServiceFeeCents: application.product.monthlyServiceFee,
          initiationFeePayment: application.initiationFeePayment,
          ndiBufferPct,
        }
        const bureauEvidence = createBureauDecisionEvidence({
          check: bureauCheck,
          minimumScore: bureauMinScore,
          blockAdverse: bureauBlockAdverse,
          override: bureauOverrideReason
            ? {
                reason: bureauOverrideReason,
                byId: guard.user.id,
                at: decisionAt,
              }
            : null,
        })
        const afford = evaluateAffordabilityGate(affordabilityInputs)
        if (afford.blocked) {
          return NextResponse.json(
            {
              error: `Affordability gate: ${afford.reason}`,
              ndi: afford.ndi,
              requiredNdi: afford.requiredNdi,
              requiresOverride: false,
            },
            { status: 422 },
          )
        }
        const approvalSnapshot = createAffordabilitySnapshot({
          stage: "APPROVAL",
          policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
          capturedAt: decisionAt,
          capturedById: guard.user.id,
          inputs: affordabilityInputs,
          applicationDebts,
          clientDebts,
          expenseEvidence,
          bureauEvidence,
          calculation: loanCalc,
          calculationStartDate,
          outcome: {
            netDisposableIncomeCents: afford.ndi,
            ndiAfterLoanCents: afford.ndi - instalment,
            requiredNdiCents: afford.requiredNdi,
            isAffordable: !afford.blocked,
            reason: afford.reason ?? null,
          },
        })

        // PEP / sanctions screening (lib/screening): re-screens when stale, then
        // a match refers to a senior reviewer and a sanctions match blocks with
        // no override. The transaction re-reads it under the client's screening
        // lock; the trigger LoanApplication_a1_guard_screening is the backstop.
        const screening = await borrowerScreeningGate({
          tenantId: tenant.id,
          borrower: { clientId: application.clientId, entityId: null },
          applicationId: id,
          actor: { id: guard.user.id, email: guard.user.email },
        })
        // A screening refusal found only inside the approve transaction (the
        // re-read under the lock, or the trigger): the same audited 422.
        const screeningChangedRefusal = async (refusalReason: string) => {
          await auditRefusal({
            action: AuditAction.SCREENING_APPROVAL_REFUSED,
            entity: "LoanApplication",
            entityId: id,
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            reason: refusalReason,
            status: 422,
          })
          return NextResponse.json(
            { error: "Approval blocked: the client's screening changed while approving. Review it and try again.", requiresOverride: false },
            { status: 422 },
          )
        }
        if (!screening.allowed) {
          await auditRefusal({
            action: AuditAction.SCREENING_APPROVAL_REFUSED,
            entity: "LoanApplication",
            entityId: id,
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            reason: screening.selfDecided ? "screening_self_decided" : `screening_${screening.state.state.toLowerCase()}`,
            status: 422,
          })
          return NextResponse.json(
            {
              error: `Approval blocked: ${screening.message}`,
              screening: screening.state,
              requiresOverride: false,
              ...(screening.providerError ? { screeningProviderError: screening.providerError } : {}),
            },
            { status: 422 },
          )
        }

        // Credit checks (lib/credit-checks) refer, they do not decide: every
        // flag still OPEN after a fresh recompute blocks approval until a
        // LOAN_ADMIN clears it with a reason. The transaction re-counts under
        // the row lock and the LoanApplication trigger is the backstop.
        const checks = await recomputeApplicationFlags(tenant.id, id, { userId: guard.user.id, email: guard.user.email })
        const openChecks = (checks?.flags ?? []).filter((f) => f.status === "OPEN")
        if (openChecks.length > 0) {
          return NextResponse.json(
            {
              error: `Approval blocked: ${openChecks.length} credit check${openChecks.length === 1 ? " is" : "s are"} open. Clear ${openChecks.length === 1 ? "it" : "them"} in Credit checks first.`,
              // No summaries: they quote the statement, and this response is not
              // a logged document access. The panel shows them, and logs it.
              openChecks: openChecks.map((f) => ({ id: f.id, check: f.check, code: f.code })),
            },
            { status: 409 },
          )
        }

        // Re-read and rebuild the exact decision under coordinated database
        // locks immediately before the state write. Pinning only
        // LoanApplication.updatedAt did not detect a concurrent Client/debt or
        // Product edit because those rows have independent revisions.
        let approvalWrite
        try {
          approvalWrite = await prisma.$transaction(async (tx) => {
            const locked = await verifyLockedApprovalCandidate(tx, {
              tenantId: tenant.id,
              applicationId: id,
              expectedApplicationUpdatedAt: application.updatedAt,
              expectedApproval: approvalSnapshot,
              capturedAt: decisionAt,
              calculationStartDate,
              capturedById: guard.user.id,
              bureauOverrideReason,
              // No PASQ exists at approval by design — it is minted at the
              // signing ceremony. Downstream gates (agreement generation, sign,
              // countersign, disburse, debit mandate) still pin the exact
              // acknowledged document.
              expectedPasqDocumentSha256: null,
            })
            if (!locked.ok) return locked
            const lockedKyc = await readCompositeKycState(
              tx as unknown as CompositeKycReader,
              {
                tenantId: tenant.id,
                clientId: locked.application.client.id,
                subject: locked.application.client,
                existing: locked.application.client,
                preserveVerifiedProvenance: true,
              },
            )
            // Origination-grade, matching the pre-transaction gate. Approval must
            // not demand biometrics; sign and disburse still do.
            if (!lockedKyc.okForOrigination) {
              return { ok: false as const, reason: "kyc_changed" as const }
            }
            const openFlags = await tx.applicationCheckFlag.count({
              where: { tenantId: tenant.id, applicationId: id, status: "OPEN" },
            })
            if (openFlags > 0) {
              return { ok: false as const, reason: "checks_open" as const }
            }
            if (!(await lockedBorrowerScreeningAllows(tx, tenant.id, { clientId: locked.application.client.id, entityId: null }, guard.user.id))) {
              return { ok: false as const, reason: "screening_changed" as const }
            }
            // Evidence that arrived after the recompute read it has not been
            // checked: new or deleted statements and payslips, new statement
            // reads or model labels, or any payslip whose extraction changed since (started,
            // finished, re-run). Payslip extraction takes the client evidence
            // lock held here, so it cannot change between this and the write;
            // an upload or a statement read does not take it, so one landing
            // in that window (milliseconds) is not seen by this approval.
            const clientId = locked.application.client.id
            const asOf = checks?.evidenceAsOf ?? new Date(0)
            const newEvidence = await tx.clientDocument.count({
              where: {
                tenantId: tenant.id,
                clientId,
                docType: { in: ["BANK_STATEMENT", "PAYSLIP"] },
                OR: [{ createdAt: { gt: asOf } }, { deletedAt: { gt: asOf } }],
              },
            }) + await tx.statementAnalysis.count({
              // Model labels stored since are new evidence too: they can add living spend.
              where: { tenantId: tenant.id, OR: [{ createdAt: { gt: asOf } }, { modelCategoriesAt: { gt: asOf } }], clientDocument: { clientId } },
            })
            const payslipsNow = await tx.clientDocument.findMany({
              where: { tenantId: tenant.id, clientId, docType: "PAYSLIP", deletedAt: null, createdAt: { gte: checks?.evidenceSince ?? new Date(0) } },
              select: { id: true, extractionStatus: true, extractionGeneration: true },
            })
            const seen = new Set(checks?.payslipSnapshot ?? [])
            const payslipsChanged = payslipsNow.length !== seen.size || payslipsNow.some((d) => !seen.has(payslipStateKey(d)))
            // Statements by set too, not only by timestamp, through the same
            // query the recompute recorded them with.
            const statementsNow = await statementSnapshot(tx, { tenantId: tenant.id, clientId, since: checks?.evidenceSince ?? new Date(0) })
            const seenStatements = [...(checks?.statementSnapshot ?? [])].sort()
            const statementsChanged = statementsNow.join("|") !== seenStatements.join("|")
            // No recompute ran (nothing returned, or the application had left
            // review): nothing was checked, whatever the evidence counts say.
            if (!checks?.recomputed || newEvidence > 0 || payslipsChanged || statementsChanged) {
              return { ok: false as const, reason: "checks_stale" as const }
            }
            // The declared expenses the checks compared the statements with:
            // an edit since then (an explicit R0 included) has not been checked.
            // The Client row is held FOR SHARE by verifyLockedApprovalCandidate.
            const expensesNow = await tx.client.findFirst({
              where: { id: clientId, tenantId: tenant.id },
              select: { monthlyExpenses: true, monthlyExpensesDeclaredAt: true },
            })
            if (!expensesNow || declaredExpenses(expensesNow) !== (checks.declaredExpensesCents ?? null)) {
              return { ok: false as const, reason: "checks_stale_expenses" as const }
            }
            const approved = await tx.loanApplication.updateMany({
              where: {
                id,
                tenantId: tenant.id,
                status: "UNDER_REVIEW",
                updatedAt: locked.application.updatedAt,
              },
              data: {
                status: "APPROVED",
                repaymentMethod,
                approvedById: guard.user.id,
                approvedAt: decisionAt,
                approvedAmount: approvalPrincipal,
                approvedTermDays: approvalTermDays,
                approvedRate: locked.application.product.interestRatePm,
                decisionReason: reason || "Approved",
                // Re-approval always starts a new agreement lifecycle. Clear any
                // stale artefacts defensively even if this UNDER_REVIEW row came
                // from legacy/manual data rather than the return-to-review route.
                agreementGeneratedAt: null,
                agreementDocumentId: null,
                agreementDocumentSha256: null,
                agreementSignedAt: null,
                agreementSignedMethod: null,
                agreementSignedByIp: null,
                agreementSignedByUserId: null,
                agreementSignatureData: null,
                agreementCountersignedAt: null,
                agreementCountersignedById: null,
                agreementCountersignedByName: null,
                agreementCountersignedByEmail: null,
                agreementCountersignatureData: null,
                agreementCountersignatureSha256: null,
                agreementCountersignatureEnvelopeSha256: null,
                agreementCountersignedDocumentSha256: null,
                // The EXECUTED artifact belongs to the agreement lifecycle being
                // torn down. Leaving it set makes the application permanently
                // un-countersignable: the countersign preflight refuses on it, and
                // its updateMany predicate requires it to be null. That blocks
                // disbursement with no in-app remedy.
                agreementExecutedDocumentId: null,
                agreementExecutedDocumentSha256: null,
                // Same reason, for the RETURNED packet: a binding left pointing at
                // a signed packet after its agreement lifecycle is torn down
                // outlives the truth it recorded. The card would surface it again
                // the moment a new agreement is generated.
                signedPacketDocumentId: null,
                signedPacketDocumentSha256: null,
                debitMandatePreparedAt: null,
                debitMandateReference: null,
                debitMandateDraftSha256: null,
                debitMandateEvidence: Prisma.DbNull,
                debitMandateEvidenceSha256: null,
                debitMandateSignedAt: null,
                debitMandateSignedMethod: null,
                debitMandateSignedByIp: null,
                debitMandateSignatureData: null,
                debitMandateSignatureSha256: null,
                debitMandateDocumentId: null,
                debitMandateDocumentSha256: null,
                // Every approval starts a fresh signing ceremony, so it also
                // starts a fresh quotation. Clearing these guarantees the PASQ
                // the consumer acknowledges is minted AFTER this decision and is
                // still inside its s.92(3) binding window at signature — and
                // stops an in-flight application carrying a PASQ generated under
                // the previous pre-approval sequencing into its ceremony.
                pasqVersion: null,
                pasqGeneratedAt: null,
                pasqDocumentId: null,
                pasqDocumentSha256: null,
                pasqEvidence: Prisma.DbNull,
                pasqEvidenceSha256: null,
                pasqAcknowledgedAt: null,
                pasqAcknowledgedBy: null,
                pasqAcknowledgedSha256: null,
                approvedPasqDocumentSha256: null,
                totalExistingDebt: declaredDebt,
                netDisposableIncome: afford.ndi,
                affordabilityNDI: afford.ndi - instalment,
                affordabilityResult: withAffordabilitySnapshot(
                  application.affordabilityResult,
                  approvalSnapshot,
                ) as unknown as Prisma.InputJsonValue,
                bureauOverrideReason,
                bureauOverrideById: bureauOverrideReason ? guard.user.id : null,
                bureauOverrideAt: bureauOverrideReason ? decisionAt : null,
                // Persist bureau override into dedicated columns so the disburse
                // gate has a first-class boolean to read (not a forgeable text
                // prefix on `recklessLendingNote`, which LOAN_ADMIN can write
                // freely via `/api/applications/[id]/compliance`). Also stamp
                // the broader reckless-lending assessment columns for ops
                // dashboards and NCR audit queries.
                ...(bureauOverrideReason && {
                  recklessLendingAssessed: true,
                  recklessLendingAssessedById: guard.user.id,
                  recklessLendingAssessedAt: decisionAt,
                }),
              },
            })
            if (approved.count !== 1) {
              return { ok: false as const, reason: "application_changed" as const }
            }

            // Both in-app routes into UNDER_REVIEW already clear and retire the
            // executed artifact, so this only fires for a legacy or manually
            // edited row. Left behind, such a document is visible in the client's
            // list, refused by documents/[id]/view (its binding is now gone), and
            // undeletable via the locked-statutory guard — permanently stuck. It
            // must be retired here or never, exactly as in the sibling blocks.
            if (application.agreementExecutedDocumentId) {
              await tx.clientDocument.updateMany({
                where: {
                  id: application.agreementExecutedDocumentId,
                  tenantId: tenant.id,
                  clientId: application.clientId,
                  docType: "EXECUTED_CREDIT_AGREEMENT",
                  deletedAt: null,
                },
                data: {
                  deletedAt: decisionAt,
                  deletedByType: "staff",
                  deletedById: guard.user.id,
                },
              })
            }

            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.LOAN_APPROVED,
                entity: "LoanApplication",
                entityId: id,
                oldValue: { status: application.status },
                newValue: {
                  status: "APPROVED",
                  repaymentMethod,
                  reason: reason || "Approved",
                  approvedAmount: approvalPrincipal,
                  approvedTermDays: approvalTermDays,
                  approvedRate: locked.application.product.interestRatePm,
                  // The quotation is issued at the signing ceremony, so an
                  // approval records the instalment it actually gated on rather
                  // than a PASQ digest. PASQ_GENERATED / PASQ_ACKNOWLEDGED audit
                  // rows carry the document evidence.
                  approvedInstalmentCents: instalment,
                  creditLifePremiumCents,
                  ...(bureauOverrideReason ? { bureauOverride: bureauOverrideReason } : {}),
                },
              },
            })
            // The credit-life commit invariant is deferred: run it here so a
            // refusal reaches the catch below instead of failing the commit.
            await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
            return { ok: true as const }
          })
        } catch (error) {
          // A loan booked on a never-approved application (the demo seed does
          // this) cannot be approved without being disbursed in the same commit.
          if (String(error).includes("Loan creation and application disbursement must commit together")) {
            return NextResponse.json(
              { error: "This application already has a loan booked against it, so it cannot be approved." },
              { status: 409 }
            )
          }
          // The screening trigger: a run that landed after the re-read above.
          if (isScreeningRefusal(error)) return await screeningChangedRefusal("screening_trigger")
          // The open-check-flags trigger: a flag raised after the count above.
          if (String(error).includes("open credit-check flags")) {
            return NextResponse.json(
              { error: "Approval blocked: a credit check was raised while approving. Refresh Credit checks and clear it first." },
              { status: 409 },
            )
          }
          throw error
        }
        if (!approvalWrite.ok) {
          if (approvalWrite.reason === "kyc_changed") {
            return NextResponse.json(
              {
                error: "KYC evidence changed before the application could be approved; refresh and complete KYC again.",
                kycEvidence: "changed",
              },
              { status: 409 },
            )
          }
          if (approvalWrite.reason === "checks_stale") {
            return NextResponse.json(
              { error: "Statements or payslips changed while approving (one arrived, was deleted, or finished extracting). Refresh Credit checks and review them first." },
              { status: 409 },
            )
          }
          if (approvalWrite.reason === "screening_changed") return await screeningChangedRefusal("screening_changed")
          if (approvalWrite.reason === "checks_stale_expenses") {
            return NextResponse.json(
              { error: "The client's declared expenses changed while approving. Refresh Credit checks and review them first." },
              { status: 409 },
            )
          }
          if (approvalWrite.reason === "checks_open") {
            return NextResponse.json(
              { error: "Approval blocked: a credit check was raised while approving. Refresh Credit checks and clear it first." },
              { status: 409 },
            )
          }
          if (approvalWrite.reason === "compliance_changed") {
            return NextResponse.json(
              {
                error: "Compliance evidence changed before the application could be approved; refresh and try again.",
                complianceEvidence: approvalWrite.reason,
              },
              { status: 409 },
            )
          }
          return NextResponse.json(
            {
              error: "Affordability evidence changed before the application could be approved; refresh, reassess, and try again.",
              affordabilitySnapshot: approvalWrite.reason,
            },
            { status: 409 }
          )
        }

        // triggerNotification's WhatsApp leg (lib/notifications.ts) now
        // sources reference + amount from the DB and lands in /inbox — no
        // separate manual send needed (that duplicate used the raw
        // application id as "Ref" instead of application.reference, and
        // bypassed /inbox since it never wrote a Message/Conversation row).
        triggerNotification({
          tenantId: tenant.id,
          event: "loan_approved",
          loanId: application.id,
          clientId: application.clientId,
        }).catch(() => {})
      } else if (action === "decline") {
        const declineCategory = parseDeclineCategory(formData.get("declineCategory"))
        if (!declineCategory) {
          return NextResponse.json(
            { error: "Choose a decline category." },
            { status: 400 }
          )
        }
        // Keep the state transition and its mandatory legal decision audit in
        // one transaction. A failed audit insert must leave the application
        // UNDER_REVIEW rather than creating an unaudited decline.
        const decisionAt = new Date()
        let declined: boolean
        try {
          declined = await prisma.$transaction(async (tx) => {
            const changed = await tx.loanApplication.updateMany({
              where: {
                id,
                tenantId: tenant.id,
                status: "UNDER_REVIEW",
                updatedAt: application.updatedAt,
              },
              data: {
                status: "DECLINED",
                approvedById: guard.user.id,
                approvedAt: decisionAt,
                decisionReason: reason || "Declined",
                declineCategory,
              },
            })
            if (changed.count === 0) return false

            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.LOAN_DECLINED,
                entity: "LoanApplication",
                entityId: id,
                oldValue: { status: application.status },
                newValue: { status: "DECLINED", reason: reason || "Declined", declineCategory },
              },
            })
            // The credit-life commit invariant is deferred: run it here so a
            // refusal reaches the catch below instead of failing the commit.
            await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
            return true
          })
        } catch (error) {
          // A loan booked on a never-approved application (the demo seed
          // does this) keeps it in DRAFT, SUBMITTED or UNDER_REVIEW.
          if (String(error).includes("Loan creation and application disbursement must commit together")) {
            return NextResponse.json(
              { error: "This application already has a loan booked against it, so it cannot be declined." },
              { status: 409 }
            )
          }
          throw error
        }
        if (!declined) {
          return NextResponse.json(
            { error: "Application status changed before it could be declined; refresh and try again." },
            { status: 409 }
          )
        }

        // See the approve branch above — triggerNotification's WhatsApp leg
        // now covers this correctly; no separate manual send needed.
        triggerNotification({
          tenantId: tenant.id,
          event: "application_declined",
          loanId: application.id,
          clientId: application.clientId,
        }).catch(() => {})
      } else {
        return NextResponse.json({ error: "Invalid action" }, { status: 400 })
      }

      return NextResponse.json({ ok: true })
    })
  } catch (error) {
    // A bare catch here discarded the cause entirely, so a failing decision
    // surfaced as an unattributable 500 with nothing in the logs.
    console.error("[decide] decision failed:", error)
    return NextResponse.json(
      { error: "Failed to process decision" },
      { status: 500 }
    )
  }
}
