// Duplicate-lead detection: what makes two leads the same person.
//
// Detect + flag only. This module deliberately contains NO merge: merging
// leads moves identities and messages between POPIA data subjects and is its
// own reviewed change. Everything here is read-only inference that staff
// eyeball before acting.
//
// Deliberately free of `prisma`, so that this rule stays importable from
// anywhere — including a client component, where a prisma import would bundle
// server code for the browser and only `npm run build` would catch it. The
// query that feeds this lives in lib/crm/lead-dedup-search.ts (server-only).
//
// The normalisers come from lib/contact/identity.ts rather than being
// re-implemented here: that module already defines the canonical spelling of a
// phone and an email for every ContactIdentity write in the system, and a
// second spelling would let the CRM and the contact directory disagree.
//
// Canonical spelling is not the same question as "is this the same person",
// though, and the gap is this module's job to close. identity.ts is strict
// where it protects its unique index and lax where the index does not care:
// `normaliseEmail` performs NO validation at all, so "N/A" is a perfectly good
// index key. The `usable*Key` guards below are what turn a spelling into an
// identity claim. See KNOWN LIMITS at the bottom of this file.

import { normaliseEmail, normalisePhone } from "@/lib/contact/identity"

/** Why two leads look like the same person. Both can apply at once. */
export type DuplicateReason = "PHONE" | "EMAIL"

/** The fields duplicate detection reads. `Lead.phone` is non-null in the
 *  schema; typed nullable here so a partial `select` can't silently coerce a
 *  missing column into a match. */
export type LeadDedupFields = {
  id: string
  email: string | null
  phone: string | null
}

/**
 * A lead's match keys, or null where the stored value is no evidence of
 * identity.
 *
 * Null is not "empty" — it means THIS LEAD CANNOT MATCH ON THIS CHANNEL. The
 * one thing this whole module must never do is treat a value that MANY
 * unrelated leads happen to share as proof they are one person. That value is
 * never rare: `Lead.email` is optional and validated nowhere on any write path
 * (both public website endpoints keep their email regex in the client
 * component only), and `Lead.phone` is required with a bare truthiness check —
 * so "N/A", "none" and "0000000000" are all reachable, and all repeat. Fifty
 * leads carrying "n/a" must not each report forty-nine possible duplicates.
 */
export type LeadDedupKeys = {
  phone: string | null
  email: string | null
}

/**
 * Whether a normalised email is SHAPED like an address rather than like free
 * text.
 *
 * This is deliberately NOT email validation and NOT a claim of deliverability.
 * It rejects "n/a", "none", "-" — values that are not addresses at all. It does
 * NOT, and cannot, reject an address-shaped placeholder: "noemail@gmail.com"
 * and "test@test.com" pass, and if many leads carry one they will cluster. See
 * KNOWN LIMITS.
 *
 * Rejecting a real address costs a missed flag; accepting a placeholder costs a
 * cluster of strangers' personal details on screen. The check errs toward
 * rejecting, but only within what shape alone can decide.
 */
function usableEmailKey(normalised: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)
}

/**
 * Whether a normalised phone is evidence of a person rather than a placeholder.
 *
 * `normalisePhone` rejects most junk for us, but not all of it: its regex is
 * `/^0\d{9}$/`, which contradicts its own docstring ("second digit 1-8") and so
 * accepts "0000000000", happily returning "27000000000" — a real-looking key
 * that any lead can carry when the caller declines to give a number. The
 * mismatch is identity.ts's to resolve; correcting it there would re-key every
 * ContactIdentity in the system, so the guard lives here.
 *
 * The rule is repeated-digit subscriber numbers only ("000000000",
 * "111111111"). Real numbers with runs of zeros (e.g. +27000001230)
 * still key normally. It is a narrow rule, not a complete one: "0123456789" is
 * just as common a placeholder and sails through. See KNOWN LIMITS.
 *
 * It can also reject a structurally valid number — 0666666666 is well-formed
 * (066 is an assigned mobile prefix) and would be dropped. That direction is
 * the cheap one: it costs one missed flag, where accepting a placeholder costs
 * a cluster.
 *
 * `slice(-9)` takes the subscriber digits from the END rather than assuming a
 * two-character prefix. normalisePhone's "0027…" branch does not in fact always
 * return a "27"-prefixed string (identity.ts:56 accepts any "002" + 10 digits),
 * and a future normaliser could return a different length — slicing from the
 * end says what this needs rather than depending on today's arithmetic.
 */
function usablePhoneKey(normalised: string): boolean {
  const subscriber = normalised.slice(-9)
  return !/^(\d)\1*$/.test(subscriber)
}

export function leadDedupKeys(lead: { email: string | null; phone: string | null }): LeadDedupKeys {
  const phone = lead.phone === null ? "" : normalisePhone(lead.phone)
  const email = lead.email === null ? "" : normaliseEmail(lead.email)
  return {
    phone: phone.length > 0 && usablePhoneKey(phone) ? phone : null,
    email: email.length > 0 && usableEmailKey(email) ? email : null,
  }
}

/**
 * Which channels make `a` and `b` look like the same person. `[]` = not a
 * duplicate.
 *
 * The `!== null` guards are load-bearing, not defensive noise: without them
 * `a.phone === b.phone` is true when BOTH are null, so two leads with
 * unparseable phones (or two with no email) would match on having nothing in
 * common. The keys are compared, never the raw columns — "+27821234567" and
 * "0821234567" are the same number written twice, and staging holds exactly
 * that pair under two different names.
 */
export function duplicateReasons(a: LeadDedupKeys, b: LeadDedupKeys): DuplicateReason[] {
  const reasons: DuplicateReason[] = []
  if (a.phone !== null && a.phone === b.phone) reasons.push("PHONE")
  if (a.email !== null && a.email === b.email) reasons.push("EMAIL")
  return reasons
}

export type LeadDuplicate<T extends LeadDedupFields> = {
  lead: T
  reasons: DuplicateReason[]
}

/**
 * Candidates that share a phone or an email with `subject`.
 *
 * `candidates` MUST already be scoped to the subject's tenant — `Lead` is
 * absent from TENANT_SCOPED_MODELS (lib/tenant-scope.ts), so nothing upstream
 * injects a tenant filter and a caller that forgets one would surface another
 * tenant's client list as "possible duplicates" of this lead. The caller owns
 * that filter; see lib/crm/lead-dedup-search.ts.
 *
 * The subject is excluded by id, so a candidate list that includes the subject
 * (the natural result of "all leads in this tenant") does not report the lead
 * as its own duplicate.
 */
export function findDuplicateLeads<T extends LeadDedupFields>(
  subject: LeadDedupFields,
  candidates: T[]
): LeadDuplicate<T>[] {
  const subjectKeys = leadDedupKeys(subject)
  if (subjectKeys.phone === null && subjectKeys.email === null) return []

  const out: LeadDuplicate<T>[] = []
  for (const candidate of candidates) {
    if (candidate.id === subject.id) continue
    const reasons = duplicateReasons(subjectKeys, leadDedupKeys(candidate))
    if (reasons.length > 0) out.push({ lead: candidate, reasons })
  }
  return out
}

/**
 * How many OTHER leads on the board share each lead's phone number, keyed by
 * lead id. Leads with no duplicate are ABSENT from the map rather than present
 * with 0, so the caller's `> 0` test cannot be satisfied by a self-match.
 *
 * Whole-board, one pass, no query. The per-lead search
 * (lib/crm/lead-dedup-search.ts) scans up to 5000 rows for ONE subject, which
 * is right for a detail page a human opened and ruinous for a kanban of cards.
 * The board already holds every lead for the tenant in memory, so grouping is
 * the cheap shape; it also means the caller MUST pass the whole tenant's leads,
 * because a partial list silently under-counts rather than erroring.
 *
 * PHONE ONLY, deliberately, and this is the one place the board's rule is
 * narrower than the review page's. KNOWN LIMITS (bottom of this file) records
 * that an address-shaped placeholder — "test@test.com" — is a valid email match
 * key, tolerated because the review page shows the evidence to a human who can
 * see the cluster is junk. A card badge has no such reader: it is permanent,
 * unexplained, and if it is usually wrong staff stop reading it, which costs
 * the true positives too. `Lead.phone` is required on every write path and
 * guarded against repeated-digit placeholders by `usablePhoneKey`, so it is the
 * channel that survives being shown without its evidence. The cost is a missed
 * badge for one person who applied twice under two numbers — still flagged on
 * the review page, which keeps both channels.
 */
export function countDuplicatesByPhone(leads: LeadDedupFields[]): Map<string, number> {
  const idsByKey = new Map<string, string[]>()
  for (const lead of leads) {
    const key = leadDedupKeys(lead).phone
    if (key === null) continue
    const group = idsByKey.get(key)
    if (group) group.push(lead.id)
    else idsByKey.set(key, [lead.id])
  }

  const counts = new Map<string, number>()
  for (const group of idsByKey.values()) {
    if (group.length < 2) continue
    for (const id of group) counts.set(id, group.length - 1)
  }
  return counts
}

/** Human-readable match reason, for the review page and the flag. */
export function describeReasons(reasons: DuplicateReason[]): string {
  const parts = reasons.map((r) => (r === "PHONE" ? "same phone number" : "same email address"))
  if (parts.length === 0) return ""
  if (parts.length === 1) return parts[0]
  return parts.join(" and ")
}

/**
 * Trim an over-fetched candidate page down to the cap, reporting whether the
 * cap bound.
 *
 * `rows` must have been fetched with `take: limit + 1` — that extra row is the
 * whole mechanism, and it is what distinguishes "a page that exactly filled the
 * cap" (truncated: false) from "there is more" (truncated: true). Lives here,
 * apart from the query, because the boundary is silent when wrong: a `>` that
 * became a `>=` would report truncation one row early forever and nothing would
 * look broken.
 */
export function applyCandidateCap<T>(
  rows: T[],
  limit: number
): { candidates: T[]; truncated: boolean } {
  const truncated = rows.length > limit
  return {
    candidates: truncated ? rows.slice(0, limit) : rows,
    truncated,
  }
}

// KNOWN LIMITS — things this rule deliberately does NOT catch.
//
// An ADDRESS-SHAPED placeholder still clusters. "noemail@gmail.com" and
// "test@test.com" are real match keys, and if fifty leads carry one then each
// reports forty-nine possible duplicates. This is the likelier junk vector than
// "N/A", not the rarer one: the staff form (components/crm/LeadForm.tsx) leaves
// email OPTIONAL, so someone with no address leaves it blank and keys to null
// already — whereas the public apply form DEMANDS an address shape, so a
// visitor unwilling to give one types something that looks like an address.
// Shape alone cannot separate those from real addresses.
//
// Two fixes were considered and rejected. A denylist of known placeholders is
// unbounded guesswork — enumerating what strangers happen to type is a game you
// cannot finish, and without production data its contents would be invention. A
// frequency rule (ignore any key shared by more than N leads) is data-driven and
// tempting, but it fails silently and in the wrong direction: a genuinely shared
// number — a family, an employer's switchboard — would cross the threshold and
// its duplicates would vanish with no signal, which is worse than noise a human
// can see through. The review page shows the evidence, so a cluster of
// "noemail@gmail.com" is visibly junk the moment anyone opens it. Revisit with
// real data, not before.
//
// Two leads whose phones are byte-identical but unparseable (a foreign number,
// say) are not flagged, even though an identical string is decent evidence of
// one person. Matching them would mean falling back to the raw string when
// normalisation fails — but normalisation also fails on "N/A", so that same
// fallback would make every lead with an unparseable placeholder a duplicate of
// every other one. That is the failure mode this module exists to prevent, and
// it is worse than the miss: a false positive puts strangers' contact details
// in front of staff, while a false negative just leaves a duplicate unflagged
// for a human to notice the way they do today. If foreign numbers ever matter,
// the answer is a real phone-parsing library, not a raw-string fallback.
