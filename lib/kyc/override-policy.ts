import type { UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { hasMinRole } from "@/lib/permissions"
import { FACE_MISMATCH_FLOOR } from "@/lib/kyc/face-model/models"
import { isManualKycExceptionableAttempt } from "@/lib/kyc/manual-exception-policy"

export const KYC_OVERRIDE_MIN_ROLES = ["BRANCH_MANAGER", "ADMIN"] as const
export const KYC_OVERRIDE_ENABLED_DEFAULT = true
export const KYC_OVERRIDE_MIN_ROLE_DEFAULT: KycOverrideMinRole = "ADMIN"
export const KYC_OVERRIDE_SECOND_APPROVER_DEFAULT = false
export type KycOverrideMinRole = (typeof KYC_OVERRIDE_MIN_ROLES)[number]
export type KycOverrideKind = "EXCEPTION" | "IN_PERSON"
export type KycOverrideMode = "direct" | "request" | "approve"

export type KycOverridePolicy = {
  enabled: boolean
  minRole: KycOverrideMinRole
  secondApprover: boolean
  requireStaffTotp: boolean
}

export type KycOverrideAttempt = {
  extractionStatus: string
  biometricFailureReason: unknown
  similarity: number | null
  faceVerdict: { samePerson?: unknown } | null
}

export type KycOverrideEligibilityInput = {
  kind: KycOverrideKind
  mode: KycOverrideMode
  attempt: KycOverrideAttempt | null
  policy: KycOverridePolicy
  caller: { role: UserRole; totpVerified: boolean }
}

export type KycOverrideRefusalCode =
  | "clear_mismatch"
  | "never_exceptionable"
  | "overrides_disabled"
  | "role_below_policy"
  | "totp_required"
  | "second_approver_required"

export type KycOverrideEligibility =
  | { allowed: true }
  | { allowed: false; code: KycOverrideRefusalCode }

export function isKycOverrideMinRole(value: unknown): value is KycOverrideMinRole {
  return value === "BRANCH_MANAGER" || value === "ADMIN"
}

export function readFaceModelSimilarity(biometricResult: unknown): number | null {
  if (!biometricResult || typeof biometricResult !== "object" || Array.isArray(biometricResult)) return null
  const faceModel = (biometricResult as Record<string, unknown>).faceModel
  if (!faceModel || typeof faceModel !== "object" || Array.isArray(faceModel)) return null
  const similarity = (faceModel as Record<string, unknown>).similarity
  return typeof similarity === "number" && Number.isFinite(similarity) ? similarity : null
}

export function readFaceVerdict(biometricResult: unknown): KycOverrideAttempt["faceVerdict"] {
  if (!biometricResult || typeof biometricResult !== "object" || Array.isArray(biometricResult)) return null
  const verdict = (biometricResult as Record<string, unknown>).faceVerdict
  return verdict && typeof verdict === "object" && !Array.isArray(verdict)
    ? verdict as { samePerson?: unknown }
    : null
}

export function isClearFaceMismatch(attempt: KycOverrideAttempt): boolean {
  if (attempt.faceVerdict?.samePerson === "different") return true
  if (attempt.similarity !== null) return attempt.similarity < FACE_MISMATCH_FLOOR
  // A missing score is fail-closed only when this was a face-match decision,
  // not for unrelated failures such as liveness or image quality.
  return attempt.biometricFailureReason === "match_score_below_threshold" ||
    attempt.biometricFailureReason === "provider_verification_failed" ||
    attempt.faceVerdict !== null
}

export function overrideEligibility(input: KycOverrideEligibilityInput): KycOverrideEligibility {
  const { kind, mode, attempt, policy, caller } = input
  if (kind === "EXCEPTION") {
    if (!attempt || !isManualKycExceptionableAttempt(attempt)) {
      return { allowed: false, code: "never_exceptionable" }
    }
    if (isClearFaceMismatch(attempt)) return { allowed: false, code: "clear_mismatch" }
  }
  if (!policy.enabled) return { allowed: false, code: "overrides_disabled" }
  if (!hasMinRole(caller.role, policy.minRole)) return { allowed: false, code: "role_below_policy" }
  if (policy.requireStaffTotp && !caller.totpVerified) return { allowed: false, code: "totp_required" }
  if (policy.secondApprover && mode === "direct") return { allowed: false, code: "second_approver_required" }
  return { allowed: true }
}

export type KycOverridePolicyState = Omit<KycOverridePolicy, "requireStaffTotp"> & {
  lastChange: { at: Date; byEmail: string | null } | null
}

export async function getKycOverridePolicy(tenantId: string): Promise<Omit<KycOverridePolicy, "requireStaffTotp">> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { kycOverrideEnabled: true, kycOverrideMinRole: true, kycOverrideSecondApprover: true },
  })
  return {
    enabled: config?.kycOverrideEnabled ?? KYC_OVERRIDE_ENABLED_DEFAULT,
    minRole: isKycOverrideMinRole(config?.kycOverrideMinRole)
      ? config.kycOverrideMinRole
      : KYC_OVERRIDE_MIN_ROLE_DEFAULT,
    secondApprover: config?.kycOverrideSecondApprover ?? KYC_OVERRIDE_SECOND_APPROVER_DEFAULT,
  }
}

export async function getKycOverridePolicyState(tenantId: string): Promise<KycOverridePolicyState> {
  const [policy, last] = await Promise.all([
    getKycOverridePolicy(tenantId),
    prisma.auditLog.findFirst({
      where: { tenantId, action: AuditAction.KYC_OVERRIDE_POLICY_UPDATED, entity: "TenantConfig", entityId: tenantId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, userEmail: true },
    }),
  ])
  return { ...policy, lastChange: last ? { at: last.createdAt, byEmail: last.userEmail } : null }
}

type PolicyTx = Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig" | "auditLog">

export async function getLockedKycOverridePolicy(
  tx: Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig">,
  tenantId: string,
): Promise<KycOverridePolicy> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kyc-override-policy:${tenantId}`}))`
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR SHARE`
  const config = await tx.tenantConfig.findUnique({
    where: { tenantId },
    select: {
      kycOverrideEnabled: true,
      kycOverrideMinRole: true,
      kycOverrideSecondApprover: true,
      requireStaffTotp: true,
    },
  })
  return {
    enabled: config?.kycOverrideEnabled ?? KYC_OVERRIDE_ENABLED_DEFAULT,
    minRole: isKycOverrideMinRole(config?.kycOverrideMinRole)
      ? config.kycOverrideMinRole
      : KYC_OVERRIDE_MIN_ROLE_DEFAULT,
    secondApprover: config?.kycOverrideSecondApprover ?? KYC_OVERRIDE_SECOND_APPROVER_DEFAULT,
    requireStaffTotp: config?.requireStaffTotp ?? true,
  }
}

export async function applyKycOverridePolicy(
  tx: PolicyTx,
  args: {
    tenantId: string
    actor: { id: string; email: string }
    enabled: boolean
    minRole: KycOverrideMinRole
    secondApprover: boolean
    ipAddress?: string
  },
): Promise<{ changed: boolean; enabled: boolean; minRole: KycOverrideMinRole; secondApprover: boolean }> {
  const { tenantId, actor, enabled, minRole, secondApprover, ipAddress } = args
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kyc-override-policy:${tenantId}`}))`
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const stored = await tx.tenantConfig.findUnique({
    where: { tenantId },
    select: { kycOverrideEnabled: true, kycOverrideMinRole: true, kycOverrideSecondApprover: true },
  })
  const previous = {
    enabled: stored?.kycOverrideEnabled ?? KYC_OVERRIDE_ENABLED_DEFAULT,
    minRole: isKycOverrideMinRole(stored?.kycOverrideMinRole)
      ? stored.kycOverrideMinRole
      : KYC_OVERRIDE_MIN_ROLE_DEFAULT,
    secondApprover: stored?.kycOverrideSecondApprover ?? KYC_OVERRIDE_SECOND_APPROVER_DEFAULT,
  }
  if (previous.enabled === enabled && previous.minRole === minRole && previous.secondApprover === secondApprover) {
    return { changed: false, enabled, minRole, secondApprover }
  }
  await tx.tenantConfig.upsert({
    where: { tenantId },
    update: { kycOverrideEnabled: enabled, kycOverrideMinRole: minRole, kycOverrideSecondApprover: secondApprover },
    create: { tenantId, kycOverrideEnabled: enabled, kycOverrideMinRole: minRole, kycOverrideSecondApprover: secondApprover },
  })
  await logAuditStrict({
    tenantId,
    userId: actor.id,
    userEmail: actor.email,
    action: AuditAction.KYC_OVERRIDE_POLICY_UPDATED,
    entity: "TenantConfig",
    entityId: tenantId,
    oldValue: previous,
    newValue: { enabled, minRole, secondApprover },
    ipAddress,
  }, tx)
  return { changed: true, enabled, minRole, secondApprover }
}
