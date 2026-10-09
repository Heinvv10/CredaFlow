/**
 * Presentation helpers for reversed payments, shared by the PDF statement
 * (`lib/pdf/statement.ts`) and the portal statement page. Kept dependency-free
 * (no `pdf-lib`) so importing it into a React server component doesn't pull the
 * PDF library into that page's bundle.
 *
 * Fixes #421 minors: a reversed row used to replace the method column with just
 * "Reversed" (losing the original method), and never surfaced reversedAt /
 * reversalReason.
 */

/**
 * Method-column label. For a reversed payment it KEEPS the original method and
 * appends the reversal marker, e.g. "EFT / Reversed" — so the reader still sees
 * how the (now-voided) payment was tendered. `method` must already be formatted
 * for the surface (the PDF and portal capitalise differently).
 */
export function methodLabelWithReversal(method: string, reversed: boolean | undefined): string {
  return reversed ? `${method} / Reversed` : method
}

/**
 * One-line reversal detail for a footnote/tooltip, e.g.
 * "Reversed 14 Jul 2026 — Duplicate capture". Returns null when the payment is
 * not reversed. The date formatter is injected so each surface stays consistent
 * with its own locale helper (`formatDatePdf` vs `formatDate`).
 */
export function reversalDetailLine(
  p: { reversed?: boolean; reversedAt?: Date | null; reversalReason?: string | null },
  formatDate: (d: Date) => string,
): string | null {
  if (!p.reversed) return null
  const when = p.reversedAt ? `Reversed ${formatDate(new Date(p.reversedAt))}` : "Reversed"
  const reason = p.reversalReason?.trim()
  return reason ? `${when} — ${reason}` : when
}
