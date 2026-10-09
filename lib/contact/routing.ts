// Where a Contacts-directory row should navigate, and the shared "needs
// triage" predicate that both the Contacts list and the Contact detail page
// rely on. Extracted so the two surfaces can never disagree about which
// contacts are ambiguous.

import { leadConversionState } from "@/lib/crm/lead-conversion"

export type AmbiguousMatchPayload = { clients?: string[]; leads?: string[] }

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

export function isAmbiguousMatchPayload(value: unknown): value is AmbiguousMatchPayload {
  if (value === null || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  // Strict element-type check — a corrupted row with non-string IDs would
  // throw inside the downstream prisma `id: { in: [...] }` filter.
  return (
    (v.clients === undefined || isStringArray(v.clients)) &&
    (v.leads === undefined || isStringArray(v.leads))
  )
}

/**
 * A contact needs operator triage when its ambiguous-match staging holds at
 * least one candidate client or lead. Mirrors the detail page's triage panel
 * predicate exactly — a non-null-but-empty payload is NOT triage.
 */
export function contactNeedsTriage(ambiguousMatchCandidates: unknown): boolean {
  if (!isAmbiguousMatchPayload(ambiguousMatchCandidates)) return false
  const clientCount = ambiguousMatchCandidates.clients?.length ?? 0
  const leadCount = ambiguousMatchCandidates.leads?.length ?? 0
  return clientCount > 0 || leadCount > 0
}

export type ContactRouteInput = {
  id: string
  clientId: string | null
  leadId: string | null
  ambiguousMatchCandidates: unknown
  lead?: {
    status: string
    convertedToClientId: string | null
    convertedToApplicationId: string | null
    conversionRecoveryRequired: boolean
  } | null
}

/**
 * Where a Contacts-directory row should navigate. Skips the intermediate
 * identity page whenever the contact resolves cleanly to one record; keeps it
 * only for ambiguous (triage) rows or contacts with nothing to route to.
 *
 * Precedence: triage first (ambiguity must be resolved before any record is
 * trustworthy), then an incomplete/stranded conversion (which must remain on
 * the Lead recovery surface), then Client, then Lead. Only an exact completed
 * conversion may follow the client that the lead became.
 */
export function resolveContactHref(c: ContactRouteInput): string {
  if (contactNeedsTriage(c.ambiguousMatchCandidates)) return `/contacts/${c.id}`

  const conversionState = c.lead
    ? leadConversionState(
        c.lead.status,
        c.lead.convertedToClientId,
        c.lead.convertedToApplicationId,
        c.lead.conversionRecoveryRequired,
      )
    : null
  if (
    c.leadId &&
    (conversionState === "INCOMPLETE" || conversionState === "STRANDED")
  ) {
    return `/crm/leads/${c.leadId}`
  }

  if (c.clientId) return `/clients/${c.clientId}`
  if (c.leadId) {
    if (conversionState === "COMPLETE" && c.lead?.convertedToClientId) {
      return `/clients/${c.lead.convertedToClientId}`
    }
    return `/crm/leads/${c.leadId}`
  }
  // Unknown / dormant / staff contact with no linked record — nothing to route
  // to, so the identity page is the only meaningful destination.
  return `/contacts/${c.id}`
}
