// Single source of truth for the localStorage keys of the public funnel drafts,
// so the writers (apply/qualify pages) and every reader (NavBar's "has draft"
// login-continuation check) can never drift apart — a key mismatch silently
// breaks draft detection (2026-07 review found NavBar stuck on a stale v1 key
// after the qualify draft bumped to v2).
//
// Bump the version suffix when the stored SHAPE changes incompatibly; that
// discards old drafts instead of misreading them. QUALIFY went v1→v2 when the
// wizard term moved to canonical DAYS (was display-unit days/months).
export const APPLY_DRAFT_KEY = "lms:website-apply:draft:v1"
export const QUALIFY_DRAFT_KEY = "lms:qualify:draft:v2"

// POPIA: these drafts hold applicant PII (name, 13-digit SA ID, phone,
// email, income) in localStorage, which persists indefinitely on a
// shared/kiosk device. Bound retention instead of relying on the user to
// clear it — a draft older than this is treated as gone, not restored.
export const DRAFT_TTL_MS = 48 * 60 * 60 * 1000 // 48 hours

/**
 * True if `updatedAt` (an ISO timestamp string, as written by the apply and
 * qualify draft writers) is present, parseable, and within `ttlMs` of `now`.
 * Missing or unparseable timestamps are treated as stale — a draft written
 * before this field existed should not be restored indefinitely.
 */
export function isDraftFresh(
  updatedAt: string | undefined,
  now: number,
  ttlMs: number = DRAFT_TTL_MS,
): boolean {
  if (!updatedAt) return false
  const ts = Date.parse(updatedAt)
  if (Number.isNaN(ts)) return false
  return now - ts < ttlMs
}
