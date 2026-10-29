/**
 * Security events as audit rows: sign-ins, failed sign-ins, TOTP failures and
 * refused permissions. LoginLog and FailedLoginAttempt stay (the rate limiter
 * and the breach audits read them); these rows are what is tamper-evident and
 * forwarded to the lender's SIEM. Best effort like logAudit: a sign-in is never
 * failed by the audit write.
 *
 * A failed sign-in is resolved to the staff account by email so it lands on that
 * lender's chain (and its SIEM); one that matches no account is not written.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"

export type SecurityEventKind = "login_succeeded" | "login_failed" | "totp_failed" | "permission_denied"

const ACTION: Record<SecurityEventKind, string> = {
  login_succeeded: AuditAction.SECURITY_LOGIN_SUCCEEDED,
  login_failed: AuditAction.SECURITY_LOGIN_FAILED,
  totp_failed: AuditAction.SECURITY_TOTP_FAILED,
  permission_denied: AuditAction.SECURITY_PERMISSION_DENIED,
}

export interface SecurityEvent {
  kind: SecurityEventKind
  tenantId?: string | null
  userId?: string | null
  email?: string | null
  ipAddress?: string | null
  /** A short reason code (the failure reason, the role required); never a secret. */
  reason?: string
  audience?: string
}

/** The staff account an address belongs to, so a failed sign-in lands on that lender's chain. */
async function staffOf(email: string): Promise<{ id: string; tenantId: string | null } | null> {
  try {
    return await prisma.user.findUnique({ where: { email }, select: { id: true, tenantId: true } })
  } catch (error) {
    console.error("[security-events] staff lookup failed:", error)
    return null
  }
}

export async function recordSecurityEvent(e: SecurityEvent): Promise<void> {
  // Best effort, like logAudit: a sign-in or a refusal is never failed by its audit row.
  try {
    await writeSecurityEvent(e)
  } catch (error) {
    console.error("[security-events] not recorded:", { kind: e.kind, error })
  }
}

async function writeSecurityEvent(e: SecurityEvent): Promise<void> {
  const known = !e.tenantId && e.email ? await staffOf(e.email) : null
  // A failure against an address that is no staff account has no lender: it is not written
  // (the audit log is immutable and this input is unauthenticated); FailedLoginAttempt keeps it.
  if ((e.kind === "login_failed" || e.kind === "totp_failed") && !e.tenantId && !known?.tenantId) return
  await logAudit({
    tenantId: e.tenantId ?? known?.tenantId ?? undefined,
    userId: e.userId ?? known?.id ?? undefined,
    userEmail: e.email ?? undefined,
    action: ACTION[e.kind],
    entity: "Session",
    newValue: { ...(e.reason ? { reason: e.reason } : {}), ...(e.audience ? { audience: e.audience } : {}) },
    ipAddress: e.ipAddress ?? undefined,
  })
}
