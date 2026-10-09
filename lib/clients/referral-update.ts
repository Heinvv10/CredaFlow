// hasMinRole comes from lib/permissions (zero imports) rather than
// lib/auth-guards (pulls in next-auth), so this module stays pure and both the
// API route and the server-rendered edit page can share one predicate.
import { hasMinRole } from "@/lib/permissions"
import type { UserRole } from "@prisma/client"

// Decides what a client PUT should do with `referralCodeId`, kept out
// of the route handler so every branch is unit-testable without a DB.
//
// The field drives referral agent commission on every repeat loan
// (lib/referral-agents/commission.ts), so it is money. Three rules follow from that:
//
//  1. KEY PRESENCE. An omitted key means "leave it alone", never "clear it".
//     The edit form only sends the key once its agent list has loaded, so a
//     failed fetch must not erase an agent's commission trail.
//  2. AUTHORISATION. Creating a referral agent or code requires LOAN_ADMIN
//     (app/api/agent-hub/agents/route.ts). Re-pointing a client's commission at
//     a different agent is the same class of act, so it carries the same floor
//     — even though the surrounding PUT only needs CREDIT_OFFICER. An
//     unchanged value is exempt: a credit officer editing a phone number must
//     not be blocked by a field they are merely round-tripping.
//  3. STALENESS. A changed value must resolve to an ACTIVE code owned by an
//     ACTIVE agent (checked by the caller). An UNCHANGED value skips that
//     check, so a client sitting on a since-retired code stays editable.

// Minimum role required to re-point a client's commission at another agent.
export const REFERRAL_REASSIGN_MIN_ROLE = "LOAN_ADMIN" as const

// Single predicate shared by the API route and the edit page, so the read-only
// UI and the 403 can never disagree about who may reassign. Unknown roles
// (including "CLIENT") are not in the hierarchy and are denied.
export function canReassignReferralAgent(role: string | null | undefined): boolean {
  return !!role && hasMinRole(role as UserRole, REFERRAL_REASSIGN_MIN_ROLE)
}

export type ReferralUpdatePlan =
  /** Key absent — do not write the column at all. */
  | { kind: "absent" }
  /** Malformed payload → 400. */
  | { kind: "invalid"; message: string }
  /** Caller may not re-point commission → 403. */
  | { kind: "forbidden"; message: string }
  /** Same value as on file — write is a no-op; skip re-validation and audit. */
  | { kind: "unchanged"; codeId: string | null }
  /** Genuine move — caller must re-validate `codeId` before writing. */
  | { kind: "change"; codeId: string | null; previousCodeId: string | null }

export function planReferralUpdate(opts: {
  data: Record<string, unknown>
  previousCodeId: string | null
  actorRole: string | null | undefined
}): ReferralUpdatePlan {
  const { data, previousCodeId, actorRole } = opts

  if (!Object.prototype.hasOwnProperty.call(data, "referralCodeId")) {
    return { kind: "absent" }
  }

  const raw = data.referralCodeId
  if (raw != null && typeof raw !== "string") {
    return { kind: "invalid", message: "Referral agent must be a code id or null" }
  }

  const codeId = typeof raw === "string" && raw.trim() ? raw.trim() : null
  if (codeId === previousCodeId) return { kind: "unchanged", codeId }

  if (!canReassignReferralAgent(actorRole)) {
    return {
      kind: "forbidden",
      message: "Changing the referral agent requires a loan administrator",
    }
  }

  return { kind: "change", codeId, previousCodeId }
}
