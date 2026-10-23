/**
 * The valuation-guide provider contract (docs/asset-finance/SLICE5.md part
 * C). A provider reads a whole dated guide; the rows are stored as a DRAFT
 * ValuationGuide that a second admin publishes, and every lookup reads
 * published rows whatever the provider (./lookup.ts). No real provider is
 * included: `csv` reads an uploaded file, `synthetic` returns fixture rows.
 */

/** One guide line: make, model, year and variant → VAT-inclusive trade and retail value in cents. */
export interface GuideRow {
  /** The file line (the header is line 1). */
  lineNumber: number
  make: string
  model: string
  year: number
  /** "" when the guide gives none. */
  variant: string
  tradeCents: number
  retailCents: number
}

/** A reason a guide was refused; one per line, every reason on it joined. Line 1 is the file itself or its header. */
export interface GuideProblem {
  line: number
  reason: string
}

export type GuideReadResult =
  | { ok: true; rows: GuideRow[]; sha256: string }
  | { ok: false; problems: GuideProblem[]; total: number }

export interface ValuationProvider {
  /** Registry key, stored on ValuationGuide.provider (CHECK ^[a-z0-9-]{1,40}$). */
  id: string
  label: string
  /** Its values are fabricated: labelled wherever they appear, refused on a deployed build unless allowed. */
  simulated: boolean
  /** Throws ValuationProviderError NOT_CONFIGURED when it may not run in this environment. */
  assertUsable(): void
  /** Reads the guide: the uploaded file's bytes for a file provider; the effective date it is loaded for. */
  readGuide(input: { bytes?: Uint8Array; effectiveOn: string }): Promise<GuideReadResult>
}

export type ValuationProviderErrorCode = "NOT_CONFIGURED" | "UNAVAILABLE"

export class ValuationProviderError extends Error {
  constructor(readonly code: ValuationProviderErrorCode, message: string) {
    super(message)
    this.name = "ValuationProviderError"
  }
}
