/**
 * The lender's Risk Management and Compliance Programme (RMCP), as uploaded.
 * CredaFlow stores, versions and dates it; it generates no RMCP text. The
 * content is the lender's and its compliance officer's.
 */

export const RMCP_MAX_BYTES = 10 * 1024 * 1024
export const RMCP_TITLE_MAX = 200
/** "Due soon" when the review date is this close. */
export const RMCP_REVIEW_WARNING_DAYS = 30

export type RmcpReviewState = "CURRENT" | "DUE_SOON" | "OVERDUE"

export function rmcpReviewState(reviewDueAt: Date, now: Date = new Date()): RmcpReviewState {
  const due = reviewDueAt.getTime()
  if (due < now.getTime()) return "OVERDUE"
  if (due - now.getTime() <= RMCP_REVIEW_WARNING_DAYS * 24 * 60 * 60 * 1000) return "DUE_SOON"
  return "CURRENT"
}

/** PDF only, by content, not by the browser's claimed type. */
export function isPdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-"
}

export type RmcpUploadFields = { title: string; reviewDueAt: Date }

export function parseRmcpFields(title: unknown, reviewDueAt: unknown, now: Date = new Date()): { ok: true; value: RmcpUploadFields } | { ok: false; error: string } {
  const t = typeof title === "string" ? title.trim() : ""
  if (!t || t.length > RMCP_TITLE_MAX) return { ok: false, error: `Give a title of up to ${RMCP_TITLE_MAX} characters.` }
  const due = typeof reviewDueAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reviewDueAt) ? new Date(`${reviewDueAt}T00:00:00.000Z`) : null
  if (!due || Number.isNaN(due.getTime()) || due.getTime() <= now.getTime()) {
    return { ok: false, error: "Give a review date (YYYY-MM-DD) in the future." }
  }
  return { ok: true, value: { title: t, reviewDueAt: due } }
}
