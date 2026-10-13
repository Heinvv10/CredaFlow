import { hasMinRole, type AppRole } from "@/lib/auth-guards"

/**
 * Who may change a lead's stage, log an activity/note or pin one, schedule a
 * callback or mark it lost. Mirrors the requireMinRole bar on updateLeadStatus,
 * addLeadActivity and toggleLeadActivityPinned (app/actions) and the
 * requireApiRole bar on the lead callback and lost routes: the UI hides the
 * controls below it so nobody is refused by an action they should never have
 * been offered.
 */
export function canWriteLeadActivity(role: AppRole | undefined | null): boolean {
  return !!role && hasMinRole(role, "CREDIT_OFFICER")
}
