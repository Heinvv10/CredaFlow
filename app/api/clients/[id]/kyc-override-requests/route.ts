import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import {
  getLockedKycOverridePolicy,
  overrideEligibility,
  readFaceModelSimilarity,
  readFaceVerdict,
} from "@/lib/kyc/override-policy"
import {
  MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS,
  MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS,
  hasMinimumManualKycExceptionCharacters,
  normalizeManualKycExceptionText,
} from "@/lib/kyc/manual-exception-policy"
import {
  IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS,
  isInPersonKycVerificationMethod,
} from "@/lib/kyc/in-person-verification"
import { latestSelfieOrder } from "@/lib/kyc/document-state"
import { expireAndListPendingKycOverrideRequests } from "@/lib/kyc/override-requests"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("BRANCH_MANAGER")
  if (guard.error) return guard.error
  try {
    return await withTenantContext(req, async (tenant) => {
    const { id: clientId } = await params
    const requests = await expireAndListPendingKycOverrideRequests({
      tenantId: tenant.id,
      clientId,
      actor: guard.user,
    })
    return NextResponse.json({ requests })
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json({ error: "The KYC evidence changed concurrently. Refresh and try again." }, { status: 409 })
    }
    console.error("Failed to create KYC override request:", error)
    return NextResponse.json({ error: "Failed to create KYC override request." }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("BRANCH_MANAGER")
  if (guard.error) return guard.error
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const kind = body?.kind
  if (kind !== "EXCEPTION" && kind !== "IN_PERSON") {
    return NextResponse.json({ error: "kind must be EXCEPTION or IN_PERSON." }, { status: 400 })
  }
  const payload = kind === "EXCEPTION"
    ? {
        reason: typeof body?.reason === "string" ? normalizeManualKycExceptionText(body.reason) : "",
        supportingEvidence: typeof body?.supportingEvidence === "string" ? normalizeManualKycExceptionText(body.supportingEvidence) : "",
      }
    : {
        method: body?.method,
        note: typeof body?.note === "string" ? normalizeManualKycExceptionText(body.note) : "",
      }
  if (kind === "EXCEPTION" && (
    !hasMinimumManualKycExceptionCharacters(payload.reason as string, MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS) ||
    !hasMinimumManualKycExceptionCharacters(payload.supportingEvidence as string, MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS)
  )) return NextResponse.json({ error: "A complete reason and supporting evidence are required." }, { status: 400 })
  if (kind === "IN_PERSON" && (
    !isInPersonKycVerificationMethod(payload.method) ||
    !hasMinimumManualKycExceptionCharacters(payload.note as string, IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS)
  )) return NextResponse.json({ error: "A valid method and complete in-person verification note are required." }, { status: 400 })

  try {
    return await withTenantContext(req, async (tenant) => {
      const { id: clientId } = await params
      const outcome = await prisma.$transaction(async (tx) => {
      const policy = await getLockedKycOverridePolicy(tx, tenant.id)
      await lockAffordabilityClientEvidence(tx, { tenantId: tenant.id, clientId })
      if (!policy.secondApprover) return { kind: "not_required" as const }
      const client = await tx.client.findUnique({ where: { id: clientId, tenantId: tenant.id }, select: { id: true } })
      if (!client) return { kind: "missing" as const }
      const selfie = kind === "EXCEPTION" ? await tx.clientDocument.findFirst({
        where: { tenantId: tenant.id, clientId, docType: "SELFIE" },
        orderBy: latestSelfieOrder(),
        select: { id: true, extractionStatus: true, biometricResult: true },
      }) : null
      const result = overrideEligibility({
        kind,
        mode: "request",
        attempt: selfie ? {
          extractionStatus: selfie.extractionStatus,
          biometricFailureReason: (selfie.biometricResult as Record<string, unknown> | null)?.biometricFailureReason,
          similarity: readFaceModelSimilarity(selfie.biometricResult),
          faceVerdict: readFaceVerdict(selfie.biometricResult),
        } : null,
        policy,
        caller: { role: guard.user.role, totpVerified: guard.user.totpVerified === true },
      })
      if (!result.allowed) return { kind: "refused" as const, code: result.code }
      const existing = await tx.kycOverrideRequest.findFirst({
        where: { tenantId: tenant.id, clientId, kind, status: "PENDING" },
        select: { id: true },
      })
      if (existing) return { kind: "exists" as const, id: existing.id }
      const requestedAt = new Date()
      const created = await tx.kycOverrideRequest.create({
        data: {
          tenantId: tenant.id,
          clientId,
          selfieDocumentId: selfie?.id ?? null,
          kind,
          payload: payload as Prisma.InputJsonValue,
          requestedById: guard.user.id,
          requestedWithTotp: guard.user.totpVerified === true,
          requestedAt,
          expiresAt: new Date(requestedAt.getTime() + SEVEN_DAYS_MS),
        },
        select: { id: true, requestedAt: true, expiresAt: true },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.KYC_OVERRIDE_REQUESTED,
        entity: "KycOverrideRequest",
        entityId: created.id,
        oldValue: null,
        newValue: { clientId, kind, selfieDocumentId: selfie?.id ?? null, requestedAt: created.requestedAt.toISOString(), expiresAt: created.expiresAt.toISOString() },
      }, tx)
      return { kind: "created" as const, request: created }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      if (outcome.kind === "missing") return NextResponse.json({ error: "Client not found" }, { status: 404 })
      if (outcome.kind === "not_required") return NextResponse.json({ error: "This lender does not require a second approver." }, { status: 409 })
      if (outcome.kind === "exists") return NextResponse.json({ error: "A pending override request already exists.", requestId: outcome.id }, { status: 409 })
      if (outcome.kind === "refused") {
        const status = outcome.code === "clear_mismatch" || outcome.code === "never_exceptionable" ? 422 : 403
        return NextResponse.json({ error: "KYC override request refused.", code: outcome.code }, { status })
      }
      return NextResponse.json({ ok: true, request: outcome.request }, { status: 201 })
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json({ error: "The KYC evidence changed concurrently. Refresh and try again." }, { status: 409 })
    }
    console.error("Failed to create KYC override request:", error)
    return NextResponse.json({ error: "Failed to create KYC override request." }, { status: 500 })
  }
}
