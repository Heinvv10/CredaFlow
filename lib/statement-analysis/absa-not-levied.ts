/** Shared by both ABSA layouts (absa.ts, absa-estatement.ts). */
import type { StatementTransaction } from "./types"

/**
 * Fees ABSA prints but has not levied: "( PENDING )" and "DECLINED FEE". The
 * words alone are not enough — a client can type them into a reference — so
 * the balance must confirm it. Rows are taken in runs ending at the next
 * printed balance (or the closing balance): the run's marked rows are
 * non-posting only when that balance is reached without them and not with
 * them. Otherwise nothing is marked and the balance check reports the run.
 */
const NOT_LEVIED = /\(\s*PENDING\s*\)|\bDECLINED FEE\b/i

export function markNotLevied(rows: StatementTransaction[], opening: number | null, closing: number | null): StatementTransaction[] {
  const out = [...rows]
  let base = opening
  let start = 0
  for (let i = 0; i < rows.length; i++) {
    const last = i === rows.length - 1
    const anchor = rows[i].balanceCents ?? (last ? closing : null)
    if (anchor === null) continue
    const run = rows.slice(start, i + 1)
    const marked = run.map((t) => NOT_LEVIED.test(t.description) && t.amountCents !== 0)
    const all = run.reduce((sum, t) => sum + t.amountCents, 0)
    const posted = run.reduce((sum, t, j) => sum + (marked[j] ? 0 : t.amountCents), 0)
    if (base !== null && marked.some(Boolean) && base + all !== anchor && base + posted === anchor) {
      marked.forEach((m, j) => { if (m) out[start + j] = { ...run[j], nonPosting: true } })
    }
    base = anchor
    start = i + 1
  }
  return out
}
