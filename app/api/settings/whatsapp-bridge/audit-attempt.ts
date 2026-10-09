import { logAudit } from "@/lib/audit"

/**
 * Writes the audit row for a WA-bridge admin action that FAILED.
 *
 * Why this exists: every mutating route here calls logAudit only after the
 * bridge call resolves, so a throw skipped the audit entirely. That is not
 * merely a missing success record — the bridge's mutations are non-atomic and
 * non-transactional, so a failure can mean the change already happened:
 * retireSlot logs the number out of WhatsApp, closes the socket and drops the
 * slot from the pool BEFORE its last step, and an HTTP timeout can land after
 * the bridge already committed. The result was a number logged out of
 * WhatsApp, a 502 shown to the admin, and an empty AuditLog.
 *
 * CLAUDE.md makes the audit trail load-bearing for a regulated lender, and
 * "the action may or may not have taken effect" is exactly the state auditors
 * need recorded. Mirrors the lesson in
 * feedback_audit_must_precede_non_transactional_writes: the audit must survive
 * the failure of the thing it describes.
 */
export async function logWaBridgeActionFailed(args: {
  tenantId: string
  userId?: string
  userEmail?: string
  action: string
  slotId: string
  error: unknown
  detail?: Record<string, unknown>
}): Promise<void> {
  await logAudit({
    tenantId: args.tenantId,
    userId: args.userId,
    userEmail: args.userEmail,
    action: args.action,
    entity: "WaBridgeNumber",
    entityId: args.slotId,
    newValue: {
      ...args.detail,
      // A 409 means the bridge's own guard refused BEFORE attempting anything,
      // so the outcome is certain. Everything else may have been applied with
      // the response lost, and must not be recorded as a clean rejection.
      outcome: (args.error as { status?: number } | null)?.status === 409 ? "REJECTED" : "UNCERTAIN",
      error: args.error instanceof Error ? args.error.message : String(args.error),
    },
  })
}
