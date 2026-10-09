/**
 * Pure text helpers for @mentions in internal notes.
 *
 * Deliberately separate from lib/inbox/note-mentions.ts (bell + email fan-out,
 * which imports prisma): these run inside client components, and a client
 * component cannot import a module that pulls in the Prisma client.
 *
 * The whole file trades on one convention: a mention appears in the note body
 * as `@` followed by the exact label the picker showed — the staffer's name, or
 * their email address when they have no name. Nothing here resolves identity;
 * the authoritative, tenant-checked list is built by resolveMentions in
 * lib/inbox/notes.ts.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The open mention being typed: the run between the last `@` at or before the
 * caret and the caret itself, or null when the caret is not inside one.
 *
 * `at` is the index of that `@`, so a caller can replace the run in place
 * rather than guessing where it started.
 */
export function activeMentionQuery(value: string, caret: number): { at: number; query: string } | null {
  if (caret < 0) return null
  const before = value.slice(0, Math.min(caret, value.length))
  const at = before.lastIndexOf("@")
  if (at === -1) return null
  // The @ in "mail bo@x.co" belongs to an email address the agent is typing,
  // not to a mention, and treating it as a trigger opens a query ("x.co") for a
  // run nobody meant to start. Matched on the characters an email LOCAL PART is
  // made of, deliberately NOT on "anything that isn't whitespace": "(@Bo" and
  // "cc:@Bo" are real mentions, and refusing to open the picker there is worse
  // than the noise it prevents — the staffer types the name by hand and ships a
  // note that reads tagged while nobody is notified.
  if (at > 0 && /[A-Za-z0-9._%+-]/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  // One plain space is allowed — staff names are two words, and the query has
  // to survive the space before the surname. Anything else (a second space, a
  // newline, a tab) means the `@` belongs to earlier prose, not an open
  // mention, and the picker must close.
  if (/[^\S ]/.test(query)) return null
  if ((query.match(/ /g)?.length ?? 0) > 1) return null
  return { at, query }
}

/**
 * The label a mention appears under, without the leading `@`: the staffer's
 * name, or their email address when they have no name.
 *
 * Every consumer has to agree on this one string — the picker inserts it, the
 * stale-mention filter matches on it, and the bubble highlights it. Where two
 * of them disagreed, a mention was inserted that could never be highlighted.
 */
export function mentionLabel(s: { name: string | null; email?: string | null }): string {
  // Blank-after-trim is treated as absent, not just null: a staffer whose name
  // is "" would otherwise get a blank picker row that inserts a bare "@", which
  // the stale-mention filter then drops — a visible pick that tags nobody.
  return s.name !== null && s.name.trim() !== "" ? s.name : (s.email ?? "")
}

/** The most rows the picker offers for one query. */
export const MENTION_PICKER_MAX_ROWS = 8

/**
 * The staff rows a query offers: case-insensitive substring match on the label
 * the row will actually show, capped.
 *
 * Shared between the picker (which renders them) and the composer (which drives
 * the keyboard selection) on purpose: two copies of this filter would drift, and
 * then ↓ then Enter would tag someone other than the highlighted row.
 *
 * `excludeUserId` drops the note's author. resolveMentions in lib/inbox/notes.ts
 * discards a self-mention by design — nobody needs a bell for their own note —
 * so offering the row only produces an "@Me" that notifies no one.
 */
export function filterMentionable<T extends { id: string; name: string | null; email: string }>(
  staff: T[],
  query: string,
  excludeUserId?: string,
): T[] {
  const q = query.trim().toLowerCase()
  return staff
    .filter((s) => s.id !== excludeUserId && mentionLabel(s).toLowerCase().includes(q))
    .slice(0, MENTION_PICKER_MAX_ROWS)
}

/**
 * The subset of picked mentions whose visible `@label` is still in the text.
 *
 * Deleting the visible "@Jane" from a note must not silently still ping her,
 * so the text the agent is submitting — not the pick history — decides who
 * gets notified.
 */
export function mentionsStillPresent<T extends { name: string | null; email: string }>(
  mentions: T[],
  text: string,
): T[] {
  return mentions.filter((m) => {
    const label = mentionLabel(m)
    // Same blank-label guard splitMentionHighlights applies. mentionLabel now
    // falls through a blank name to the email, so this only fires when both are
    // blank — but a bare "@" is contained by any note holding a mention run, so
    // without it such a pick could never be dropped by deleting the visible tag.
    return label.trim() !== "" && text.includes(`@${label}`)
  })
}

/**
 * Splits a note body into plain and mention segments for rendering.
 *
 * Returns no segments at all for a null or empty body: toThreadMessage nulls
 * bodyText for a soft-deleted note so the text never reaches the browser, and
 * this must render nothing rather than crash or invent a segment.
 */
export function splitMentionHighlights(
  body: string | null,
  names: (string | null)[],
): { text: string; mention: boolean }[] {
  const text = body ?? ""
  if (text === "") return []
  const labels = [...new Set(names.filter((n): n is string => n !== null && n.trim() !== ""))]
    // Longest first: with ["Bo", "Bo Nkosi"] a shorter alternative would match
    // "@Bo" inside "@Bo Nkosi" and leave " Nkosi" as plain text, splitting one
    // name across two segments.
    .sort((a, b) => b.length - a.length)
    .map((n) => `@${n}`)
  if (labels.length === 0) return [{ text, mention: false }]

  const tokens = new Set(labels)
  return text
    .split(new RegExp(`(${labels.map(escapeRegExp).join("|")})`))
    .filter((part) => part !== "")
    .map((part) => ({ text: part, mention: tokens.has(part) }))
}
