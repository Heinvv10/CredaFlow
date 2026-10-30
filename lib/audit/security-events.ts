/**
 * Security events as audit rows: sign-ins, failed sign-ins, TOTP failures and
 * refused permissions. LoginLog and FailedLoginAttempt stay (the rate limiter
 * and the breach audits read them); these rows are what is tamper-evident and
 * forwarded to the lender's SIEM. Best effort like logAudit: a sign-in is never
 * failed by the audit write.
 *
 * Only the STAFF path writes them, and only with the tenant and user the caller
 * already holds: there is no lookup by email here, so a client, dealer or operator
 * sign-in, an unknown address or a refused audience can never put a row (or a
 * lender's name) on anyone's chain. The log is immutable, so the volume is bounded:
 * a failure is one row per (tenant, user, kind, source address) per window, the rows
 * suppressed in between counted on the next. A new source address is always recorded,
 * and a successful sign-in never is suppressed: it is the event that proves a
 * guessed password worked.
 */
import { AuditAction, logAudit } from "@/lib/audit"
import { logger } from "@/lib/observability/logger"

export type SecurityEventKind = "login_succeeded" | "login_failed" | "totp_failed" | "permission_denied"

const ACTION: Record<SecurityEventKind, string> = {
  login_succeeded: AuditAction.SECURITY_LOGIN_SUCCEEDED,
  login_failed: AuditAction.SECURITY_LOGIN_FAILED,
  totp_failed: AuditAction.SECURITY_TOTP_FAILED,
  permission_denied: AuditAction.SECURITY_PERMISSION_DENIED,
}

export const SECURITY_EVENT_WINDOW_MS = 5 * 60_000
const MAX_TRACKED = 10_000

export interface SecurityEvent {
  kind: SecurityEventKind
  tenantId: string
  userId: string
  email?: string | null
  ipAddress?: string | null
  /** A short reason code (the failure reason, the role required); never a secret. */
  reason?: string
}

const windows = new Map<string, { start: number; suppressed: number }>()

const keyOf = (e: SecurityEvent) => `${e.tenantId}|${e.userId}|${e.kind}|${e.ipAddress ?? ""}`

/**
 * The suppressed count to record if this event is the first of its window, else null (and the
 * suppressed one is counted). Nothing is claimed here: the window opens only once the row is
 * written, so a write that failed does not silence the next attempt.
 */
function peekWindow(e: SecurityEvent, now: number): number | null {
  if (e.kind === "login_succeeded") return 0
  const seen = windows.get(keyOf(e))
  if (seen && now - seen.start < SECURITY_EVENT_WINDOW_MS) {
    seen.suppressed++
    return null
  }
  return seen?.suppressed ?? 0
}

function openWindow(e: SecurityEvent, now: number): void {
  if (e.kind === "login_succeeded") return
  const key = keyOf(e)
  if (!windows.has(key) && windows.size >= MAX_TRACKED) windows.delete(windows.keys().next().value as string)
  windows.set(key, { start: now, suppressed: 0 })
}

export function resetSecurityEventWindows(): void {
  windows.clear()
}

export async function recordSecurityEvent(e: SecurityEvent, now: number = Date.now()): Promise<void> {
  const suppressed = peekWindow(e, now)
  if (suppressed === null) return
  try {
    await logAudit({
      tenantId: e.tenantId,
      userId: e.userId,
      userEmail: e.email ?? undefined,
      action: ACTION[e.kind],
      entity: "Session",
      newValue: { ...(e.reason ? { reason: e.reason } : {}), ...(suppressed > 0 ? { suppressedSincePrevious: suppressed } : {}) },
      ipAddress: e.ipAddress ?? undefined,
    })
    openWindow(e, now)
  } catch (error) {
    logger.error("[security-events] not recorded", { kind: e.kind, error })
  }
}
