export type ImportSummary = {
  lineCount: number
  newTxnCount: number
  autoApplied: number
  deduplicated: boolean
}

// Takes the plural form explicitly rather than appending "s": "match" -> "matchs".
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The operator-facing summary of a statement upload.
 *
 * Its own module (dep-free, like data.ts beside it) so it can be tested without
 * dragging the client component's server-action → next-auth import chain into
 * the test runner.
 *
 * The arithmetic is easy to get wrong and the cost of getting it wrong is an
 * operator who thinks nothing was posted: `newTxnCount` counts EVERY row this
 * import persisted, auto-applied ones included. So the number still awaiting
 * review is the remainder — reporting `newTxnCount` as "to review" would both
 * overstate the queue and stay silent about money already booked against real
 * loans (auto-apply runs inside the import when
 * TenantConfig.absaAutoApplyHighConfidence is on — see lib/bank-sync/import.ts).
 */
export function summariseUpload(r: ImportSummary): string {
  if (r.deduplicated) return "Already imported — this exact file was uploaded before, so nothing was added."

  const head = `Imported ${plural(r.lineCount, "line")}, ${plural(r.newTxnCount - r.autoApplied, "new transaction")} to review.`
  if (r.autoApplied === 0) return head

  return `${head} ${plural(r.autoApplied, "high-confidence match", "high-confidence matches")} auto-applied as ${
    r.autoApplied === 1 ? "a payment" : "payments"
  } — check the loan balances.`
}
