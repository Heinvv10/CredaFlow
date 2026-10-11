// Returning-applicant identity: is this new lead the same PERSON as one we are
// already working?
//
// Distinct from lib/crm/lead-dedup.ts, which answers "might these two rows be
// the same person, for a human to review". The rule here feeds an automatic
// action (notifying an agent) with no human between the match and the effect,
// so it is deliberately STRICTER: dedup matches on phone OR email; this matches
// on phone AND name.
//
// Why stricter — one phone can carry several identities (two members of one
// household, or a test account). A phone-only rule
// would treat a household's second applicant as the first one. That is why
// there is no phone-only fallback anywhere below, not even when the name is
// missing — see leadIdentityKey.
//
// Deliberately free of `prisma`, like lead-dedup.ts, so the rule stays
// importable from a client component without bundling server code into the
// browser — a mistake only `npm run build` would catch.

import { normalisePhone } from "@/lib/contact/identity"
import { leadDedupKeys } from "@/lib/crm/lead-dedup"
import { leadConversionState } from "@/lib/crm/lead-conversion"

/** The fields identity matching reads. */
export type LeadIdentityFields = {
  id: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  status: string
  convertedToClientId: string | null
  convertedToApplicationId: string | null
  conversionRecoveryRequired: boolean
}

/**
 * A person's name reduced to a comparable form: lowercase, internal whitespace
 * collapsed, trimmed. `""` means "no usable name".
 *
 * The collapse is not cosmetic. One lead may be stored as `"nhlanhla  mocktest "`
 * — double space, trailing space — alongside `"nhlanhla mocktest"`. Without it those are different people
 * and the whole rule silently stops matching the cases it exists for.
 *
 * Deliberately NOT doing more than this. Fuzzy matching (initials, nicknames,
 * edit distance, married surnames) would widen the key toward the phone-only
 * failure it is here to prevent, and every widening trades a missed
 * notification — which costs exactly what today already costs — for a chance of
 * pointing an agent at a stranger. A miss is the cheap direction.
 */
export function normaliseFullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  return [firstName ?? "", lastName ?? ""]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The identity this lead claims, or null when it does not claim one.
 *
 * Null is not "empty" — it means THIS LEAD CANNOT MATCH ANYTHING. Both halves
 * are required:
 *
 * - The phone comes from `leadDedupKeys`, which applies the placeholder guard
 *   (`0000000000` and friends) and the E.164 normalisation, so "+27…" and "0…"
 *   spellings of one number collapse to one key. Reusing that rather than
 *   re-deriving it keeps this module and the review page agreeing about what a
 *   phone number IS.
 * - A missing name yields null rather than falling back to the phone. That
 *   fallback is precisely the shared-handset bug: it would make every unnamed lead on a
 *   shared handset the same person.
 */
export function leadIdentityKey(
  lead: Pick<LeadIdentityFields, "firstName" | "lastName" | "phone">,
): string | null {
  const phone = leadDedupKeys({ phone: lead.phone, email: null }).phone
  if (phone === null) return null
  const name = normaliseFullName(lead.firstName, lead.lastName)
  if (name.length === 0) return null
  return `${phone}|${name}`
}

/**
 * Whether a lead is one an agent could still be working — the only kind worth
 * telling anyone about.
 *
 * `leadConversionState(...) === "OPEN"` is NOT sufficient on its own, and the
 * gap is easy to ship: that function answers "is this lead convertible", and a
 * LOST lead carries no conversion links, so it falls through to "OPEN". Using
 * it alone would notify an agent every time a person they had deliberately
 * written off came back — the one duplicate they had already decided about.
 *
 * CONVERTED is excluded by the state check itself (both links → COMPLETE, one
 * or neither → INCOMPLETE/STRANDED), as are recovery rows, which are a data
 * repair queue rather than live pipeline work.
 */
export function isPriorLeadCandidate(lead: Omit<LeadIdentityFields, "id" | "firstName" | "lastName" | "phone">): boolean {
  if (lead.status === "LOST") return false
  return leadConversionState(
    lead.status,
    lead.convertedToClientId,
    lead.convertedToApplicationId,
    lead.conversionRecoveryRequired,
  ) === "OPEN"
}

/**
 * Leads that are the same person as `subject` and still being worked.
 *
 * `candidates` MUST already be scoped to the subject's tenant — `Lead` is
 * absent from TENANT_SCOPED_MODELS (lib/tenant-scope.ts), so nothing upstream
 * injects a tenant filter, and a caller that forgets one would point an agent
 * at another tenant's client. The caller owns that filter.
 *
 * The subject is excluded by id so that a candidate list which includes it (the
 * natural result of "every lead in this tenant") does not report the lead as
 * its own prior self.
 */
export function findPriorOpenLeads<T extends LeadIdentityFields>(
  subject: Pick<LeadIdentityFields, "id" | "firstName" | "lastName" | "phone">,
  candidates: T[],
): T[] {
  const key = leadIdentityKey(subject)
  if (key === null) return []

  return candidates.filter(
    (candidate) =>
      candidate.id !== subject.id &&
      isPriorLeadCandidate(candidate) &&
      leadIdentityKey(candidate) === key,
  )
}

/** Re-exported so callers building a candidate query do not reach past this
 *  module for the one normaliser it does not own. */
export { normalisePhone }
