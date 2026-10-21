/**
 * A source of outcomes (DESIGN.md §4, "Source-agnostic"). Each adapter reads
 * its own rows, maps them into the source-neutral facts (./facts.ts), runs the
 * same pure definitions and hands the writer DecisionOutcome rows for its
 * `sourceSystem`. Nothing in an adapter's interface names a lender.
 */
import type { DerivedOutcome, SourceSystem } from "./definition"

export interface AdapterContext {
  tenantId: string
  asOf: Date
  /** The SAST day of asOf. */
  today: string
}

export interface AdapterResult {
  outcomes: DerivedOutcome[]
  /** Every decision the adapter evaluated, including any that now has no rows (its old rows are removed). */
  decisionRecordIds: string[]
  /** Loans whose derivation threw: counted in the job's body, never written. */
  failures: Array<{ ref: string; error: string }>
}

export interface OutcomeSourceAdapter {
  readonly sourceSystem: SourceSystem
  derive(ctx: AdapterContext): Promise<AdapterResult>
}
