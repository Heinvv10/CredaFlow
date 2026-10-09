// URL ⇄ lead-modal state for the pipeline board's ?lead=<id>&tab=<tab>
// deep-link. Pure and prisma-free (client-imported).
//
// The lead id here is URL-CONTROLLED text that ends up interpolated into
// fetch(`/api/crm/leads/${id}/detail`) — an unvalidated value like
// `..%2F..%2Fadmin` decodes to `../..` and the browser collapses the path,
// turning the request into a credentialed GET of an attacker-chosen
// same-origin path. Only a single path-safe token shape is accepted.

export type TabKey = "details" | "outreach" | "appointment" | "notes" | "activity" | "tasks"
export const TAB_KEYS: readonly TabKey[] = ["details", "outreach", "appointment", "notes", "activity", "tasks"]

// cuid-shaped: one alphanumeric token. No slash, dot, percent, or anything
// else a URL parser could re-interpret as path structure.
const LEAD_ID_SHAPE = /^[a-z0-9]{10,40}$/i

export function isLeadIdShaped(id: string): boolean {
  return LEAD_ID_SHAPE.test(id)
}

export function normalizeTab(tab: string | null | undefined): TabKey {
  return (TAB_KEYS as readonly string[]).includes(tab ?? "") ? (tab as TabKey) : "details"
}

/** Validated modal state from raw searchParams, or null when absent/invalid. */
export function parseLeadModalParams(
  lead: string | undefined,
  tab: string | undefined
): { id: string; tab: TabKey } | null {
  if (!lead || !isLeadIdShaped(lead)) return null
  return { id: lead, tab: normalizeTab(tab) }
}
