// Telling the agent who owns a lead that the same person has just come in
// again through a public form.
//
// The pure decisions live here so they can be tested without a database; the
// orchestration that queries, claims the throttle and sends lives in
// notifyPriorLeadDuplicates() below.
//
// THIS MODULE NEVER MUTATES A LEAD. The apply route still creates its new lead
// exactly as before; this only observes and tells someone. That is deliberate:
// matching is on phone + name (see lib/crm/lead-identity.ts) and one phone
// number can carry several identities, so the matcher WILL be wrong
// occasionally. Detect-only makes the cost of a wrong match a spurious
// notification rather than one person's loan application landing on another
// person's lead.

import { escapeHtml } from "@/lib/utils"

/** Fixed anti-spam bucket, matching the identity-notice cooldown already used
 *  on the apply route. */
export const DUPLICATE_NOTICE_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Throttle key. Deliberately keyed on the PRIOR lead, not the new one: the
 * thing we are rate-limiting is "how often may this agent be told about THIS
 * lead of theirs", and a key on the new lead would let five rapid submissions
 * produce five notices about the same prior lead.
 */
export function duplicateNoticeChannelKey(priorLeadId: string): string {
  return `lead-duplicate:${priorLeadId}`
}

/**
 * Start of the fixed window containing `atMs`.
 *
 * Fixed bucket rather than a sliding window because the claim must be ONE
 * atomic unique insert on (tenantId, channelKey, windowStart) — a sliding
 * window cannot be expressed as a unique constraint, which would put us back at
 * the check-then-act race the atomic claim exists to avoid. Cost is up to ~2 notices across a
 * bucket boundary; that is the accepted anti-spam bound.
 */
export function throttleWindowStart(atMs: number): Date {
  return new Date(Math.floor(atMs / DUPLICATE_NOTICE_WINDOW_MS) * DUPLICATE_NOTICE_WINDOW_MS)
}

export type PriorLeadSummary = {
  id: string
  firstName: string | null
  lastName: string | null
  status: string
  assignedToId: string | null
}

export type NoticeRecipient = { userId: string; leadIds: string[] }

/**
 * Who to tell, grouped so one agent gets one notice however many of their leads
 * matched.
 *
 * An UNASSIGNED prior lead notifies nobody. There is no owner whose queue it
 * belongs in, and the alternatives are worse: broadcasting to every credit
 * officer produces the notification everyone assumes someone else handled, and
 * a tenant fallback assignee may not exist. The duplicate badge on the board
 * and the work queue already surface unowned duplicates.
 */
export function selectNoticeRecipients(priorLeads: PriorLeadSummary[]): NoticeRecipient[] {
  const byUser = new Map<string, string[]>()
  for (const lead of priorLeads) {
    if (lead.assignedToId === null) continue
    const existing = byUser.get(lead.assignedToId)
    if (existing) existing.push(lead.id)
    else byUser.set(lead.assignedToId, [lead.id])
  }
  return [...byUser].map(([userId, leadIds]) => ({ userId, leadIds }))
}

export type DuplicateNoticeFacts = {
  applicantName: string
  priorLeadCount: number
  priorStatus: string
}

/**
 * The bell item and email body.
 *
 * Carries NO contact details — not the phone it matched on, not the email. The
 * agent clicks through to the lead, where they already see all of it. Repeating
 * a data subject's contact details into a bell row and an inbox widens where
 * that information lives for no operational gain, and the bell is retained
 * separately from the lead.
 *
 * The name is escaped for the HTML body because it is applicant-supplied free
 * text arriving from a public form.
 */
export function buildDuplicateNotice(facts: DuplicateNoticeFacts): {
  title: string
  body: string
  html: string
} {
  const noun = facts.priorLeadCount === 1 ? "open lead" : "open leads"
  // "new enquiry", never "applied": this same notice fires for the contact form
  // and the insurance enquiry, where "applied" would state something the person
  // did not do. UI copy is a factual claim.
  const title = `New enquiry from ${facts.applicantName} — matches a lead you own`
  // "matches ... by phone number and name", not "is the same person". The
  // matcher cannot tell a returning applicant from a relative sharing a
  // handset and a name, and stating identity as fact would put a false claim
  // about a consumer in front of staff. The agent decides; the notice reports
  // only what was actually compared.
  const body =
    `${facts.applicantName} submitted a new enquiry matching ${facts.priorLeadCount} ${noun} ` +
    `you are working, by phone number and name (currently ${facts.priorStatus}). Open the lead to ` +
    `check whether it is the same person before merging or closing the older card.`

  const safeName = escapeHtml(facts.applicantName)
  const safeStatus = escapeHtml(facts.priorStatus)
  const html =
    `<p>${safeName} submitted a new enquiry matching ${facts.priorLeadCount} ${noun} ` +
    `you are working, by phone number and name (currently ${safeStatus}).</p>` +
    `<p>Open the lead in the staff workspace to check whether it is the same person ` +
    `before merging or closing the older card.</p>`

  return { title, body, html }
}
