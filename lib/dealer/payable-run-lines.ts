/**
 * Which commission lines a new payable run takes (spec deviation 22, the
 * netting the database enforces in DealerPayableRunLine_netting and
 * DealerPayableRun_netting). Candidates are the dealer's lines effective by
 * the period end and in no live run. The run takes:
 *
 *   - every REVERSED (clawback) line, linked first: its EARNED line is either
 *     taken with it or already in a live run;
 *   - every EARNED line with no reversal;
 *   - an EARNED line whose reversal is taken in this run too.
 *
 * It leaves out an EARNED line whose reversal falls after the period end (or
 * sits in another live run): paying it now would pay commission already
 * clawed back. The pair nets to zero and waits for the run that takes the
 * reversal. Pure; lib/dealer/payable-runs.ts loads the candidates.
 */

export interface RunCandidate {
  id: string
  kind: "EARNED" | "REVERSED"
  netCents: number
  vatCents: number
  grossCents: number
  /** EARNED only: its REVERSED line, wherever it is dated or linked. */
  reversal: { id: string; effectiveOn: string; live: boolean } | null
}

export interface RunSelection {
  /** Link order: REVERSED lines first, then EARNED. */
  lineIds: string[]
  totalNetCents: number
  totalVatCents: number
  totalGrossCents: number
}

export function selectRunLines(candidates: readonly RunCandidate[], periodEnd: string): RunSelection {
  const reversed = candidates.filter((line) => line.kind === "REVERSED")
  const takenReversals = new Set(reversed.map((line) => line.id))
  const earned = candidates.filter((line) => {
    if (line.kind !== "EARNED") return false
    if (!line.reversal) return true
    return takenReversals.has(line.reversal.id) && line.reversal.effectiveOn <= periodEnd && !line.reversal.live
  })
  const lines = [...reversed, ...earned]
  return {
    lineIds: lines.map((line) => line.id),
    totalNetCents: lines.reduce((sum, line) => sum + line.netCents, 0),
    totalVatCents: lines.reduce((sum, line) => sum + line.vatCents, 0),
    totalGrossCents: lines.reduce((sum, line) => sum + line.grossCents, 0),
  }
}
