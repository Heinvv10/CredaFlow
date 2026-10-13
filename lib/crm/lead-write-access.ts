import { hasMinRole, type AppRole } from "@/lib/auth-guards"

/**
 * Who may change a lead's stage, log an activity/note or pin one. Mirrors the
 * requireMinRole bar on updateLeadStatus, addLeadActivity and
 * toggleLeadActivityPinned (app/actions): the UI hides the controls below it so
 * nobody is redirected by an action they should never have been offered.
 */
export function canWriteLeadActivity(role: AppRole | undefined | null): boolean {
  return !!role && hasMinRole(role, "CREDIT_OFFICER")
}
