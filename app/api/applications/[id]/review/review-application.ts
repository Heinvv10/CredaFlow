import { openApprovalCaseSafely } from "@/lib/approval/chain"
import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import type { Trigger } from "@/lib/decisioning/auto-decision"
import { runAutoDecisionSafely } from "@/lib/decisioning/run-safely"
import { runBureauReviewCheck } from "@/lib/compliance/bureau-review"
import {
  lockAffordabilityApplicationEvidence,
  lockAffordabilityClientEvidence,
} from "@/lib/affordability/evidence-locks"
import {
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { unresolvedNonBiometricDocumentMismatchWhere } from "@/lib/kyc/document-mismatches"
import { EntityBorrowerError, hasClientBorrowerId } from "@/lib/borrower"

export interface ReviewArgs {
  tenant: { id: string }
  /** The staff user the review is started under (a person's session, or the lender's system user for a digital submission). */
  user: { id: string; email: string }
  id: string
  autoDecisionTrigger: Trigger
  /** Assign the application to `user` (a person starting a review). Off for the system user: an application it refers stays unassigned for staff to pick up. */
  assignToUser?: boolean
  /**
   * Called inside the claim transaction once every gate (KYC, document mismatches) has passed and
   * before the application is claimed and the paid bureau pull is made. False refuses the review
   * with 429 and the application is left as it was. For automatic reviews that spend the lender's money
   * (lib/decisioning/digital-due.ts); a person starting a review passes none.
   */
  admit?: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<boolean>
}

export const REVIEW_NOT_ADMITTED_STATUS = 429

export type ReviewStarted = {
  ok: true
  id: string
  bureauResult: Awaited<ReturnType<typeof runBureauReviewCheck>>
  bureauReviewRetried: boolean
  autoDecision: Awaited<ReturnType<typeof runAutoDecisionSafely>>
}

/**
 * Starts the review of one application: the KYC and mismatch gates, the claim
 * (SUBMITTED to UNDER_REVIEW), the bureau enquiry and, where the lender has it
 * on, the decision engine. Everything POST in ./route.ts does once the caller
 * and tenant are known; also run for a digitally submitted application
 * (lib/decisioning/digital-submission.ts). Returns the refusal as a Response.
 */
export async function startApplicationReview({ tenant, user, id, autoDecisionTrigger, assignToUser = true, admit }: ReviewArgs): Promise<Response | ReviewStarted> {
  const claim = await prisma.$transaction(async (tx) => {
    // Approval takes application then client. Use the identical order so
    // concurrent review/approval requests cannot deadlock or audit a stale
    // predecessor generation.
    await lockAffordabilityApplicationEvidence(tx, {
      tenantId: tenant.id,
      applicationId: id,
    })
    const lockedRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "LoanApplication"
      WHERE "id" = ${id} AND "tenantId" = ${tenant.id}
      FOR UPDATE
    `)
    if (!lockedRows[0]) return { kind: "application_missing" as const }

    const application = await tx.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
    })
    if (!application) return { kind: "application_missing" as const }
    // Consumer KYC + bureau review; an entity borrower is refused.
    if (!hasClientBorrowerId(application)) return { kind: "entity_borrower" as const }
    if (application.status !== "SUBMITTED" && application.status !== "UNDER_REVIEW") {
      return { kind: "invalid_application_status" as const }
    }
    const retryingBureauReview = application.status === "UNDER_REVIEW"
    const bureauReviewGeneration = randomUUID()
    const assignedToId = assignToUser
        ? (retryingBureauReview ? application.assignedToId ?? user.id : user.id)
        : application.assignedToId

    await lockAffordabilityClientEvidence(tx, {
      tenantId: tenant.id,
      clientId: application.clientId,
    })

    const currentClient = await tx.client.findUnique({
      where: { id: application.clientId, tenantId: tenant.id },
      select: {
        id: true,
        idNumber: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        kycStatus: true,
        kycVerifiedAt: true,
        kycVerifiedById: true,
        kycVerificationMethod: true,
        kycManualRejectionActive: true,
        kycManualRejectionAt: true,
        kycManualRejectionById: true,
        kycManualRejectionReason: true,
      },
    })
    if (!currentClient) return { kind: "client_missing" as const }
    if (currentClient.kycManualRejectionActive) {
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.KYC_VERIFICATION_BLOCKED,
          entity: "LoanApplication",
          entityId: id,
          oldValue: {
            status: application.status,
            kycStatus: currentClient.kycStatus,
            manualRejectionAt: currentClient.kycManualRejectionAt,
            manualRejectionById: currentClient.kycManualRejectionById,
          },
          newValue: {
            attemptedStatus: "UNDER_REVIEW",
            blocked: true,
            reason: "manual_rejection_active",
            manualRejectionReason: currentClient.kycManualRejectionReason,
          },
        },
      })
      return {
        kind: "manual_kyc_rejection" as const,
        reason: currentClient.kycManualRejectionReason,
      }
    }

    const compositeKyc = await readCompositeKycState(
      tx as unknown as CompositeKycReader,
      {
        tenantId: tenant.id,
        clientId: application.clientId,
        subject: currentClient,
        existing: currentClient,
        preserveVerifiedProvenance: true,
      },
    )
    // Origination-grade: a selfie is not compulsory to start review. The
    // strict `ok` still gates disbursement in disburse/route.ts.
    if (!compositeKyc.okForOrigination) {
      // The selfie matched the client's first ID copy before staff
      // verified it: the remedy is verifying that copy, not a re-capture
      // and not some other document.
      if (compositeKyc.biometricAwaitingIdVerification) {
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            userEmail: user.email,
            action: AuditAction.KYC_VERIFICATION_BLOCKED,
            entity: "LoanApplication",
            entityId: id,
            oldValue: {
              status: application.status,
              latestSelfieId: compositeKyc.latestSelfieId,
            },
            newValue: {
              attemptedStatus: "UNDER_REVIEW",
              blocked: true,
              reason: "id_copy_awaiting_verification",
              latestSelfieId: compositeKyc.latestSelfieId,
              idDocumentId: compositeKyc.awaitingIdDocumentId,
              missingDocs: compositeKyc.missingCoreDocuments,
            },
          },
        })
        return {
          kind: "id_copy_awaiting_verification" as const,
          missingDocs: compositeKyc.missingCoreDocuments,
          documentId: compositeKyc.latestSelfieId,
          idDocumentId: compositeKyc.awaitingIdDocumentId,
        }
      }
      // Surface the biometric 422 only when the failed attempt IS the
      // origination blocker. `biometricEvidence` alone is non-null even
      // when no selfie was ever captured, and with core documents still
      // unverified that branch used to hide the real next step behind a
      // selfie error the officer could do nothing about.
      if (
        compositeKyc.biometricAttemptFailed &&
        compositeKyc.missingCoreDocuments.length === 0 &&
        compositeKyc.biometricEvidence
      ) {
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            userEmail: user.email,
            action: AuditAction.BIOMETRIC_VERIFICATION_BLOCKED,
            entity: "LoanApplication",
            entityId: id,
            oldValue: {
              status: application.status,
              latestSelfieId: compositeKyc.latestSelfieId,
            },
            newValue: {
              attemptedStatus: "UNDER_REVIEW",
              blocked: true,
              reason: compositeKyc.biometricEvidence,
            },
          },
        })
        return {
          kind: "invalid_biometric_evidence" as const,
          reason: compositeKyc.biometricEvidence,
          documentId: compositeKyc.latestSelfieId,
        }
      }
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.KYC_VERIFICATION_BLOCKED,
          entity: "LoanApplication",
          entityId: id,
          oldValue: { status: application.status },
          newValue: {
            attemptedStatus: "UNDER_REVIEW",
            blocked: true,
            reason: "core_documents_incomplete",
            missingDocs: compositeKyc.missingCoreDocuments,
          },
        },
      })
      return {
        kind: "incomplete_kyc" as const,
        missingDocs: compositeKyc.missingCoreDocuments,
      }
    }

    // Selfies are governed by the ordered biometric state machine above.
    // Excluding them here ensures a normal failed latest attempt receives
    // the distinct biometric 422 + audit, while an older failed attempt
    // cannot poison a newer valid recovery.
    const criticalMismatches = await tx.clientDocument.findMany({
      where: unresolvedNonBiometricDocumentMismatchWhere({
        tenantId: tenant.id,
        clientId: application.clientId,
      }),
    })
    if (criticalMismatches.length > 0) {
      return { kind: "mismatches" as const, documents: criticalMismatches }
    }

    if (admit && !(await admit(tx))) return { kind: "not_admitted" as const }

    const changed = await tx.loanApplication.updateMany({
      where: {
        id,
        tenantId: tenant.id,
        status: application.status,
        updatedAt: application.updatedAt,
        bureauReviewGeneration: application.bureauReviewGeneration,
      },
      data: {
        status: "UNDER_REVIEW",
        assignedToId,
        bureauReviewGeneration,
      },
    })
    if (changed.count === 0) return { kind: "status_changed" as const }
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        userEmail: user.email,
        action: retryingBureauReview
          ? AuditAction.APPLICATION_BUREAU_REVIEW_RETRIED
          : AuditAction.APPLICATION_REVIEW_STARTED,
        entity: "LoanApplication",
        entityId: id,
        oldValue: {
          status: application.status,
          assignedToId: application.assignedToId,
          bureauReviewGeneration: application.bureauReviewGeneration,
        },
        newValue: {
          status: "UNDER_REVIEW",
          assignedToId,
          bureauReviewGeneration,
          bureauRetry: retryingBureauReview,
        },
      },
    })
    return {
      kind: "claimed" as const,
      clientId: application.clientId,
      bureauReviewGeneration,
      retryingBureauReview,
    }
  })
  if (claim.kind === "not_admitted") {
    return NextResponse.json({ error: "The automatic review limit for today has been reached; the application stays with staff." }, { status: REVIEW_NOT_ADMITTED_STATUS })
  }
  if (claim.kind === "application_missing") {
    return NextResponse.json({ error: "Application not found" }, { status: 404 })
  }
  if (claim.kind === "entity_borrower") {
    return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
  }
  if (claim.kind === "invalid_application_status") {
    return NextResponse.json(
      { error: "Application must be submitted or under review" },
      { status: 400 },
    )
  }
  if (claim.kind === "client_missing") {
    return NextResponse.json({ error: "Client not found" }, { status: 404 })
  }
  if (claim.kind === "manual_kyc_rejection") {
    return NextResponse.json({
      error: "Cannot submit for review: the client's manual KYC rejection must be resolved by an authorised KYC decision.",
      biometricEvidence: "manual_rejection_active",
      manualRejectionReason: claim.reason,
    }, { status: 422 })
  }
  if (claim.kind === "mismatches") {
    return NextResponse.json({
      error: `Cannot submit for review: ${claim.documents.length} document(s) have unresolved data mismatches. Please review and verify each flagged document before proceeding.`,
      mismatches: claim.documents.map((document) => ({
        id: document.id,
        docType: document.docType,
        fileName: document.fileName,
      })),
    }, { status: 422 })
  }
  if (claim.kind === "invalid_biometric_evidence") {
    return NextResponse.json({
      error: "Cannot submit for review: the latest selfie does not establish current valid biometric evidence.",
      biometricEvidence: claim.reason,
      documentId: claim.documentId,
    }, { status: 422 })
  }
  if (claim.kind === "id_copy_awaiting_verification") {
    return NextResponse.json({
      error: "The client's ID copy must be verified before review; the selfie already matched it.",
      missingDocs: claim.missingDocs,
      documentId: claim.documentId,
      idDocumentId: claim.idDocumentId,
    }, { status: 422 })
  }
  if (claim.kind === "incomplete_kyc") {
    return NextResponse.json({
      error: "Cannot submit for review: all required KYC documents must be verified.",
      missingDocs: claim.missingDocs,
    }, { status: 422 })
  }
  if (claim.kind === "status_changed") {
    return NextResponse.json(
      { error: "Application status changed before the bureau review could start; refresh and try again." },
      { status: 409 },
    )
  }

  // The review has started: the approval matrix's clock starts with it (a lender with no matrix in force: nothing).
  await openApprovalCaseSafely({ tenantId: tenant.id, applicationId: id })

  // The worker validates this generation before provider I/O and again
  // under the approval lock before storing evidence. Await it here so a
  // successful HTTP response always means the provider/skipped/failure
  // result was durably recorded for this generation. Failed generations
  // remain explicitly retryable from the application UI.
  const bureauResult = await runBureauReviewCheck({
    tenantId: tenant.id,
    applicationId: id,
    clientId: claim.clientId,
    reviewGeneration: claim.bureauReviewGeneration,
  })
  if (bureauResult === "stale") {
    return NextResponse.json(
      { error: "The bureau review changed while the enquiry was running; refresh and try again." },
      { status: 409 },
    )
  }

  // The lender's decision engine (lib/decisioning/), when it is switched on
  // for this channel and product. Never blocks the review: a failure leaves
  // the application with staff.
  const autoDecision = await runAutoDecisionSafely({ tenantId: tenant.id, applicationId: id, trigger: autoDecisionTrigger })
  return { ok: true as const, id, bureauResult, bureauReviewRetried: claim.retryingBureauReview, autoDecision }
}
