import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { databaseNow } from "@/lib/db-clock"
import { findStandingInPersonAttestation } from "@/lib/kyc/in-person-standing.server"
import {
  assessBiometricEvidence,
  biometricSubjectFingerprint,
} from "@/lib/kyc/biometric-evidence"
import {
  CORE_KYC_DOCUMENT_TYPES,
  clientKycAuditValue,
  latestSelfieOrder,
} from "@/lib/kyc/document-state"
import {
  MANUAL_KYC_EXCEPTION_KIND,
  MANUAL_KYC_EXCEPTION_VERSION,
  type ManualKycExceptionEvidence,
} from "@/lib/kyc/manual-exception"
import {
  MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS,
  MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS,
  hasMinimumManualKycExceptionCharacters,
  normalizeManualKycExceptionText,
} from "@/lib/kyc/manual-exception-policy"
import {
  BLOCKING_SELFIE_CONDITIONS,
  ID_PORTRAIT_REFUSAL_CONDITIONS,
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS,
  IN_PERSON_KYC_VERIFICATION_VERSION,
  idDocumentPortraitRefused,
  inPersonAttestationIdempotencyKey,
  isInPersonKycVerificationMethod,
  selfieBlocksInPersonVerification,
  type InPersonKycVerificationEvidence,
} from "@/lib/kyc/in-person-verification"
import { selectUsableIdDocument } from "@/lib/kyc/usable-id-document"
import { outstandingCoreDocuments } from "@/lib/kyc/id-replacement"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { hasMinRole } from "@/lib/permissions"
import {
  getLockedKycOverridePolicy,
  overrideEligibility,
  readFaceModelSimilarity,
  readFaceVerdict,
} from "@/lib/kyc/override-policy"

const DECISION_REASON_MIN = 20
type ScopedTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

type ClientEvidence = {
  id: string
  idNumber: string
  firstName: string
  lastName: string
  dateOfBirth: Date | null
  kycStatus: "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED"
  kycVerifiedAt: Date | null
  kycVerifiedById: string | null
  kycVerificationMethod: "PHYSICAL" | "DIGITAL" | "BIOMETRIC" | "SMILE_IDENTITY" | null
  kycManualRejectionActive: boolean
  kycManualRejectionAt: Date | null
  kycManualRejectionById: string | null
  kycManualRejectionReason: string | null
  kycManualRejectionResolvedAt: Date | null
  kycManualRejectionResolvedById: string | null
  kycManualRejectionResolutionReason: string | null
}

const clientSelect = {
  id: true, idNumber: true, firstName: true, lastName: true, dateOfBirth: true,
  kycStatus: true, kycVerifiedAt: true, kycVerifiedById: true, kycVerificationMethod: true,
  kycManualRejectionActive: true, kycManualRejectionAt: true, kycManualRejectionById: true,
  kycManualRejectionReason: true, kycManualRejectionResolvedAt: true,
  kycManualRejectionResolvedById: true, kycManualRejectionResolutionReason: true,
} as const

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function grantException(
  tx: ScopedTransactionClient,
  args: { tenantId: string; clientId: string; selfieDocumentId: string; requestId: string; payload: unknown; actor: { id: string; email: string; totpVerified?: boolean } },
) {
  const payload = jsonRecord(args.payload)
  const reason = typeof payload?.reason === "string" ? payload.reason : ""
  const supportingEvidence = typeof payload?.supportingEvidence === "string" ? payload.supportingEvidence : ""
  if (
    !hasMinimumManualKycExceptionCharacters(reason, MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS) ||
    !hasMinimumManualKycExceptionCharacters(supportingEvidence, MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS)
  ) return { kind: "invalid_payload" as const }
  const client = await tx.client.findUnique({ where: { id: args.clientId, tenantId: args.tenantId }, select: clientSelect }) as ClientEvidence | null
  if (!client) return { kind: "client_missing" as const }
  if (client.kycManualRejectionActive) return { kind: "manual_rejection_active" as const }
  const [coreDocuments, latestSelfie] = await Promise.all([
    tx.clientDocument.findMany({
      where: { tenantId: args.tenantId, clientId: args.clientId, deletedAt: null, docType: { in: [...CORE_KYC_DOCUMENT_TYPES] } },
      select: { id: true, docType: true, verified: true, createdAt: true, verificationRejectedAt: true, verificationRejectedById: true },
    }),
    tx.clientDocument.findFirst({
      where: { tenantId: args.tenantId, clientId: args.clientId, docType: "SELFIE" },
      orderBy: latestSelfieOrder(),
      select: {
        id: true, contentSha256: true, deletedAt: true, verified: true,
        extractionStatus: true, extractionResult: true, extractionError: true,
        validationMismatch: true, validationScore: true, biometricMatchScore: true,
        biometricLiveness: true, biometricVerifiedAt: true, biometricResult: true,
      },
    }),
  ])
  if (outstandingCoreDocuments(CORE_KYC_DOCUMENT_TYPES, coreDocuments).length > 0) {
    return { kind: "core_documents_missing" as const }
  }
  if (!latestSelfie || latestSelfie.id !== args.selfieDocumentId || latestSelfie.deletedAt || !isSha256Digest(latestSelfie.contentSha256)) {
    return { kind: "selfie_changed" as const }
  }
  const idDocument = await tx.clientDocument.findFirst({
    where: { tenantId: args.tenantId, clientId: args.clientId, docType: "ID_COPY", deletedAt: null, verified: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, contentSha256: true },
  })
  const assessment = assessBiometricEvidence(latestSelfie, {
    subject: client,
    idDocument,
    idDocumentCopies: null,
    requireDocumentVerified: false,
  })
  if (assessment.ok) return { kind: "biometric_already_valid" as const }
  // The database clock under the client lock, as the in-person records use:
  // every KYC_EXCEPTION completedAt is ordered against the same clock.
  const approvedAt = await databaseNow(tx)
  const evidence: ManualKycExceptionEvidence = {
    kind: MANUAL_KYC_EXCEPTION_KIND,
    version: MANUAL_KYC_EXCEPTION_VERSION,
    clientId: args.clientId,
    documentId: latestSelfie.id,
    documentSha256: latestSelfie.contentSha256,
    subjectFingerprint: biometricSubjectFingerprint(client),
    biometricFailureReason: assessment.reason,
    reason,
    supportingEvidence,
    approvedAt: approvedAt.toISOString(),
    approvedById: args.actor.id,
    approvedByEmail: args.actor.email,
    approvedWithTotp: args.actor.totpVerified === true,
    overrideRequestId: args.requestId,
  }
  const record = await tx.complianceRecord.create({
    data: {
      tenantId: args.tenantId,
      type: "KYC_EXCEPTION",
      referenceId: args.clientId,
      idempotencyKey: ["kyc-exception", args.clientId, latestSelfie.id, latestSelfie.contentSha256].join(":"),
      status: "COMPLETED",
      completedAt: approvedAt,
      data: evidence as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  const updated = await tx.client.update({
    where: { id: args.clientId, tenantId: args.tenantId },
    data: { kycStatus: "VERIFIED", kycVerifiedAt: approvedAt, kycVerifiedById: args.actor.id, kycVerificationMethod: "PHYSICAL" },
    select: { kycStatus: true, kycVerifiedAt: true, kycVerifiedById: true, kycVerificationMethod: true },
  })
  await logAuditStrict({
    tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
    action: AuditAction.KYC_EXCEPTION_GRANTED, entity: "Client", entityId: args.clientId,
    oldValue: { clientKyc: clientKycAuditValue(client), latestSelfieId: latestSelfie.id, biometricEvidence: assessment.reason },
    newValue: { clientKyc: clientKycAuditValue(updated), exceptionRecordId: record.id, manualException: true, evidence },
  }, tx)
  return { kind: "granted" as const, client: updated, recordId: record.id }
}

async function grantInPerson(
  tx: ScopedTransactionClient,
  args: { tenantId: string; clientId: string; requestId: string; payload: unknown; actor: { id: string; email: string; totpVerified?: boolean } },
) {
  const payload = jsonRecord(args.payload)
  const method = payload?.method
  const note = typeof payload?.note === "string" ? payload.note : ""
  if (
    !isInPersonKycVerificationMethod(method) ||
    !hasMinimumManualKycExceptionCharacters(note, IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS)
  ) return { kind: "invalid_payload" as const }
  const client = await tx.client.findUnique({ where: { id: args.clientId, tenantId: args.tenantId }, select: clientSelect }) as ClientEvidence | null
  if (!client) return { kind: "client_missing" as const }
  if (client.kycManualRejectionActive) return { kind: "manual_rejection_active" as const }
  const [coreDocuments, blockingCandidates, portraitRefusals, latestAttempt] = await Promise.all([
    tx.clientDocument.findMany({
      where: { tenantId: args.tenantId, clientId: args.clientId, deletedAt: null, docType: { in: [...CORE_KYC_DOCUMENT_TYPES] } },
      select: { id: true, docType: true, verified: true, contentSha256: true, createdAt: true, verificationRejectedAt: true, verificationRejectedById: true },
      orderBy: { createdAt: "desc" },
    }),
    tx.clientDocument.findMany({
      where: { tenantId: args.tenantId, clientId: args.clientId, ...BLOCKING_SELFIE_CONDITIONS },
      select: { extractionStatus: true, biometricResult: true, createdAt: true },
    }),
    tx.clientDocument.findMany({
      where: { tenantId: args.tenantId, clientId: args.clientId, ...ID_PORTRAIT_REFUSAL_CONDITIONS },
      select: { biometricResult: true },
    }),
    tx.clientDocument.findFirst({
      where: { tenantId: args.tenantId, clientId: args.clientId, docType: "SELFIE" },
      orderBy: latestSelfieOrder(), select: { id: true, biometricResult: true },
    }),
  ])
  if (outstandingCoreDocuments(CORE_KYC_DOCUMENT_TYPES, coreDocuments).length > 0) {
    return { kind: "core_documents_missing" as const }
  }
  // The database clock, under the client evidence lock: compared with verdict
  // stamps written by other app hosts.
  const approvedAt = await databaseNow(tx)
  const idCopies = coreDocuments.filter((doc) => doc.docType === "ID_COPY")
  if (blockingCandidates.some((selfie) => selfieBlocksInPersonVerification(selfie, idCopies, approvedAt))) {
    return { kind: "biometric_attempt_exists" as const }
  }
  const idDocument = selectUsableIdDocument(coreDocuments)
  if (!idDocument) return { kind: "id_document_unusable" as const }
  if (idDocumentPortraitRefused(portraitRefusals, idDocument)) return { kind: "id_document_portrait_invalid" as const }
  const subjectFingerprint = biometricSubjectFingerprint(client)
  const evidence: InPersonKycVerificationEvidence = {
    kind: IN_PERSON_KYC_VERIFICATION_KIND,
    version: IN_PERSON_KYC_VERIFICATION_VERSION,
    clientId: args.clientId,
    idDocumentId: idDocument.id,
    idDocumentSha256: idDocument.contentSha256,
    subjectFingerprint,
    method,
    note,
    approvedAt: approvedAt.toISOString(),
    approvedById: args.actor.id,
    approvedByEmail: args.actor.email,
    approvedWithTotp: args.actor.totpVerified === true,
    overrideRequestId: args.requestId,
  }
  const idempotencyKey = inPersonAttestationIdempotencyKey({
    clientId: args.clientId, idDocument, subjectFingerprint, latestAttempt,
  })
  // The same circumstances were already attested (by either route): a refusal
  // the approver can read, not a unique-constraint failure.
  if (
    await tx.complianceRecord.findUnique({ where: { idempotencyKey }, select: { id: true } }) ||
    // The key moves when a late answer is stamped on the latest attempt, so it
    // alone would accept a second identical attestation while one stands.
    await findStandingInPersonAttestation(tx, {
      tenantId: args.tenantId, clientId: args.clientId, subject: client, idDocument, portraitRefusals,
      blockingCandidates, idDocumentCopies: idCopies,
    })
  ) {
    return { kind: "verification_exists" as const }
  }
  const record = await tx.complianceRecord.create({
    data: {
      tenantId: args.tenantId, type: "KYC_EXCEPTION", referenceId: args.clientId,
      idempotencyKey,
      status: "COMPLETED", completedAt: approvedAt,
      data: evidence as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  const updated = await tx.client.update({
    where: { id: args.clientId, tenantId: args.tenantId },
    data: { kycStatus: "VERIFIED", kycVerifiedAt: approvedAt, kycVerifiedById: args.actor.id, kycVerificationMethod: "PHYSICAL" },
    select: { kycStatus: true, kycVerifiedAt: true, kycVerifiedById: true, kycVerificationMethod: true },
  })
  await logAuditStrict({
    tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
    action: AuditAction.KYC_IN_PERSON_VERIFICATION_GRANTED, entity: "Client", entityId: args.clientId,
    oldValue: { clientKyc: clientKycAuditValue(client), biometricEvidence: "biometric_evidence_missing" },
    newValue: { clientKyc: clientKycAuditValue(updated), complianceRecordId: record.id, inPersonVerification: true, evidence },
  }, tx)
  return { kind: "granted" as const, client: updated, recordId: record.id }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const guard = await requireApiRole("BRANCH_MANAGER")
  if (guard.error) return guard.error
  const body = await req.json().catch(() => null) as { decision?: unknown; reason?: unknown } | null
  if (body?.decision !== "APPROVED" && body?.decision !== "DECLINED") {
    return NextResponse.json({ error: "decision must be APPROVED or DECLINED." }, { status: 400 })
  }
  const decisionNote = typeof body.reason === "string" ? normalizeManualKycExceptionText(body.reason) : ""
  if (!hasMinimumManualKycExceptionCharacters(decisionNote, DECISION_REASON_MIN)) {
    return NextResponse.json({ error: `Decision reason must be at least ${DECISION_REASON_MIN} characters.` }, { status: 400 })
  }
  // Which grant the transaction was attempting, so a unique-key failure is
  // reported in that grant's terms. Set inside the transaction; a retry sets it again.
  let decidingKind: "EXCEPTION" | "IN_PERSON" | null = null
  try {
    return await withTenantContext(req, async (tenant) => {
    const { id: clientId, requestId } = await params
    const outcome = await prisma.$transaction(async (tx) => {
      const policy = await getLockedKycOverridePolicy(tx, tenant.id)
      await lockAffordabilityClientEvidence(tx, { tenantId: tenant.id, clientId })
      await tx.$executeRaw`SELECT 1 FROM "KycOverrideRequest" WHERE "tenantId" = ${tenant.id} AND "id" = ${requestId} FOR UPDATE`
      const request = await tx.kycOverrideRequest.findUnique({
        where: { id: requestId, tenantId: tenant.id },
        select: {
          id: true, clientId: true, selfieDocumentId: true, kind: true, payload: true,
          requestedById: true, requestedWithTotp: true, requestedAt: true, status: true, expiresAt: true,
          requestedBy: { select: { role: true, active: true, totpEnabled: true, lastTotpCounter: true } },
        },
      })
      if (!request || request.clientId !== clientId) return { kind: "missing" as const }
      decidingKind = request.kind
      if (request.status !== "PENDING") return { kind: "already_decided" as const, status: request.status }
      const now = new Date()
      if (now > request.expiresAt) {
        await tx.kycOverrideRequest.update({
          where: { id: request.id, tenantId: tenant.id },
          data: { status: "EXPIRED", decidedById: guard.user.id, decidedAt: now, decisionNote: "Expired automatically after 7 days." },
        })
        await logAuditStrict({
          tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
          action: AuditAction.KYC_OVERRIDE_EXPIRED, entity: "KycOverrideRequest", entityId: request.id,
          oldValue: { status: "PENDING" }, newValue: { status: "EXPIRED" },
        }, tx)
        return { kind: "expired" as const }
      }
      if (request.requestedById === guard.user.id) return { kind: "self_approve" as const }

      // A policy change or newly conclusive evidence may close the approval
      // path, but a different authorized senior must still be able to decline
      // and close the request. Only reviewer authority and 2FA apply here.
      const reviewerEligibility = overrideEligibility({
        kind: "IN_PERSON",
        mode: "approve",
        attempt: null,
        policy: { ...policy, enabled: true },
        caller: { role: guard.user.role, totpVerified: guard.user.totpVerified === true },
      })
      if (!reviewerEligibility.allowed) {
        return { kind: "refused" as const, code: reviewerEligibility.code }
      }

      if (body.decision === "DECLINED") {
        await tx.kycOverrideRequest.update({
          where: { id: request.id, tenantId: tenant.id },
          data: { status: "DECLINED", decidedById: guard.user.id, decidedAt: now, decisionNote },
        })
        await logAuditStrict({
          tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
          action: AuditAction.KYC_OVERRIDE_DECLINED, entity: "KycOverrideRequest", entityId: request.id,
          oldValue: { status: "PENDING" }, newValue: { status: "DECLINED", decisionNote },
        }, tx)
        return { kind: "declined" as const }
      }

      if (
        !request.requestedBy.active ||
        !hasMinRole(request.requestedBy.role, policy.minRole) ||
        (policy.requireStaffTotp && (
          !request.requestedWithTotp ||
          !request.requestedBy.totpEnabled ||
          request.requestedBy.lastTotpCounter === null
        ))
      ) return { kind: "requester_ineligible" as const }

      const selfie = request.kind === "EXCEPTION" && request.selfieDocumentId
        ? await tx.clientDocument.findUnique({
            where: { id: request.selfieDocumentId, tenantId: tenant.id },
            select: { extractionStatus: true, biometricResult: true },
          })
        : null
      const eligibility = overrideEligibility({
        kind: request.kind,
        mode: "approve",
        attempt: selfie ? {
          extractionStatus: selfie.extractionStatus,
          biometricFailureReason: jsonRecord(selfie.biometricResult)?.biometricFailureReason,
          similarity: readFaceModelSimilarity(selfie.biometricResult),
          faceVerdict: readFaceVerdict(selfie.biometricResult),
        } : null,
        policy,
        caller: { role: guard.user.role, totpVerified: guard.user.totpVerified === true },
      })
      if (!eligibility.allowed) return { kind: "refused" as const, code: eligibility.code }

      const grant = request.kind === "EXCEPTION" && request.selfieDocumentId
        ? await grantException(tx, { tenantId: tenant.id, clientId, selfieDocumentId: request.selfieDocumentId, requestId: request.id, payload: request.payload, actor: guard.user })
        : await grantInPerson(tx, { tenantId: tenant.id, clientId, requestId: request.id, payload: request.payload, actor: guard.user })
      if (grant.kind !== "granted") return { kind: "grant_refused" as const, reason: grant.kind }
      await tx.kycOverrideRequest.update({
        where: { id: request.id, tenantId: tenant.id },
        data: { status: "APPROVED", decidedById: guard.user.id, decidedAt: now, decisionNote },
      })
      await logAuditStrict({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.KYC_OVERRIDE_APPROVED, entity: "KycOverrideRequest", entityId: request.id,
        oldValue: { status: "PENDING" }, newValue: { status: "APPROVED", decisionNote, complianceRecordId: grant.recordId },
      }, tx)
      // Prisma interactive transactions can otherwise return before a deferred
      // trigger failure is surfaced. Flush while the route can still answer a
      // conflict instead of reporting success for a rolled-back grant.
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return { kind: "approved" as const, client: grant.client, complianceRecordId: grant.recordId }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    if (outcome.kind === "missing") return NextResponse.json({ error: "Override request not found." }, { status: 404 })
    if (outcome.kind === "already_decided") return NextResponse.json({ error: `Override request is already ${outcome.status.toLowerCase()}.` }, { status: 409 })
    if (outcome.kind === "expired") return NextResponse.json({ error: "Override request expired after 7 days." }, { status: 409 })
    if (outcome.kind === "self_approve") return NextResponse.json({ error: "The requester cannot approve or decline their own override request." }, { status: 403 })
    if (outcome.kind === "requester_ineligible") return NextResponse.json({ error: "The requester no longer meets the lender policy. Decline this request and ask an eligible senior to create a new one." }, { status: 409 })
    if (outcome.kind === "refused") return NextResponse.json({ error: "Override decision refused by the current lender policy.", code: outcome.code }, { status: 403 })
    if (outcome.kind === "grant_refused") return NextResponse.json({ error: "The KYC evidence changed; review the current state before deciding.", code: outcome.reason }, { status: 409 })
    if (outcome.kind === "declined") return NextResponse.json({ ok: true, status: "DECLINED" })
    return NextResponse.json({ ok: true, status: "APPROVED", client: outcome.client, complianceRecordId: outcome.complianceRecordId })
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json({ error: "The KYC request or evidence changed concurrently. Refresh and review it again." }, { status: 409 })
    }
    // The idempotency key was taken concurrently. Nothing was written (the
    // transaction rolled back); say which grant it was.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return decidingKind === "EXCEPTION"
        ? NextResponse.json({ error: "A senior exception was already granted for this selfie. Refresh and review the client's KYC again.", code: "exception_exists" }, { status: 409 })
        : NextResponse.json({ error: "These circumstances were already attested. Refresh and review the client's KYC again.", code: "verification_exists" }, { status: 409 })
    }
    if (
      error instanceof Prisma.PrismaClientUnknownRequestError &&
      error.message.includes("KYC override")
    ) return NextResponse.json({ error: "The KYC request no longer satisfies the lender policy. Refresh and review it again." }, { status: 409 })
    console.error("Failed to decide KYC override request:", error)
    return NextResponse.json({ error: "Failed to decide KYC override request." }, { status: 500 })
  }
}
