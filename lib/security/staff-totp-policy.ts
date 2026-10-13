/**
 * The per-lender staff two-factor policy: `TenantConfig.requireStaffTotp`.
 *
 * On (the default, also for a tenant with no config row): a staff user with no
 * TOTP enrolled can sign in but reach only the enrolment page (proxy.ts,
 * lib/auth-guards.ts). Off: a code is demanded at sign-in only from a user who
 * enrolled. The one write path is applyStaffTotpRequired.
 */
import { prisma } from "@/lib/prisma"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"

export const STAFF_TOTP_REQUIRED_DEFAULT = true

export async function isStaffTotpRequired(tenantId: string): Promise<boolean> {
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { requireStaffTotp: true } })
  return config?.requireStaffTotp ?? STAFF_TOTP_REQUIRED_DEFAULT
}

export type StaffTotpPolicyState = {
  required: boolean
  /** The latest change, from its audit row; null when the setting was never changed. */
  lastChange: { at: Date; byEmail: string | null } | null
}

export async function getStaffTotpPolicyState(tenantId: string): Promise<StaffTotpPolicyState> {
  const [required, last] = await Promise.all([
    isStaffTotpRequired(tenantId),
    prisma.auditLog.findFirst({
      where: { tenantId, action: AuditAction.STAFF_TOTP_POLICY_UPDATED, entity: "TenantConfig", entityId: tenantId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, userEmail: true },
    }),
  ])
  return { required, lastChange: last ? { at: last.createdAt, byEmail: last.userEmail } : null }
}

type PolicyTx = Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig" | "user" | "auditLog">

/**
 * Set the flag inside the caller's transaction (which has already checked the
 * actor's role and TOTP-verified session). The change and its audit row commit
 * together. An unchanged value writes and audits nothing.
 *
 * A session carries the policy as it stood at sign-in, so on a change the
 * tenant's unenrolled staff, the actor excepted, are signed out (tokenVersion
 * bump): switching on forces them into enrolment at their next sign-in,
 * switching off frees any that were held there. The actor is TOTP-verified,
 * so is not locked out either way.
 */
export async function applyStaffTotpRequired(
  tx: PolicyTx,
  args: { tenantId: string; actor: { id: string; email: string }; required: boolean; ipAddress?: string },
): Promise<{ changed: boolean; required: boolean; signedOut: number }> {
  const { tenantId, actor, required, ipAddress } = args
  // Serialise writers of this tenant's setting first: with no config row yet
  // there is no row to lock, and two first switches would both read the default,
  // both upsert and both audit "on -> off".
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-totp-policy:${tenantId}`}))`
  // Lock the row, then read it, so the audited old value is the state replaced.
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const stored = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { requireStaffTotp: true } })
  const previous = stored?.requireStaffTotp ?? STAFF_TOTP_REQUIRED_DEFAULT
  if (previous === required) return { changed: false, required, signedOut: 0 }

  await tx.tenantConfig.upsert({
    where: { tenantId },
    update: { requireStaffTotp: required },
    create: { tenantId, requireStaffTotp: required },
  })
  const { count: signedOut } = await tx.user.updateMany({
    where: { tenantId, id: { not: actor.id }, totpEnabled: false, totpSecret: null },
    data: { tokenVersion: { increment: 1 } },
  })
  await logAuditStrict({
    tenantId,
    userId: actor.id,
    userEmail: actor.email,
    action: AuditAction.STAFF_TOTP_POLICY_UPDATED,
    entity: "TenantConfig",
    entityId: tenantId,
    oldValue: { requireStaffTotp: previous },
    newValue: { requireStaffTotp: required, signedOutUsers: signedOut },
    ipAddress,
  }, tx)
  return { changed: true, required, signedOut }
}
