import { SIGMA_SCORE_MAX } from "@/lib/integrations/experian"

// A type alias (not an interface) so it stays assignable to the audit log's
// Record<string, unknown> value fields — interfaces are open to declaration
// merging and TypeScript rejects them for index-signature targets.
export type CreditPolicyValues = {
  bureauMinScore: number
  bureauBlockAdverse: boolean
  ndiBufferPct: number
}

export type CreditPolicyParseResult =
  | { ok: true; values: CreditPolicyValues }
  | { ok: false; error: string }

// Below the Sigma floor (480) is a valid but uncalibrated fail-safe: the bureau
// gate treats it as "requires calibration" and forces an override rather than a
// silent pass. So the server accepts it (the client warns) — only nonsensical
// values are rejected. The ceiling is the Sigma band max: a minimum above it
// could never be met.
const SCORE_MIN_ALLOWED = 1
const NDI_BUFFER_MIN = 100
const NDI_BUFFER_MAX = 1000

/**
 * Validate the three Credit Policy fields from a raw request body. Pure — no I/O.
 * The single source of validation truth shared by the API route and its tests.
 */
export function parseCreditPolicyInput(body: unknown): CreditPolicyParseResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Invalid request body." }
  }
  const b = body as Record<string, unknown>

  const bureauMinScore = b.bureauMinScore
  if (typeof bureauMinScore !== "number" || !Number.isInteger(bureauMinScore)) {
    return { ok: false, error: "bureauMinScore must be an integer." }
  }
  if (bureauMinScore < SCORE_MIN_ALLOWED || bureauMinScore > SIGMA_SCORE_MAX) {
    return { ok: false, error: `bureauMinScore must be between ${SCORE_MIN_ALLOWED} and ${SIGMA_SCORE_MAX}.` }
  }

  const ndiBufferPct = b.ndiBufferPct
  if (typeof ndiBufferPct !== "number" || !Number.isInteger(ndiBufferPct)) {
    return { ok: false, error: "ndiBufferPct must be an integer." }
  }
  if (ndiBufferPct < NDI_BUFFER_MIN || ndiBufferPct > NDI_BUFFER_MAX) {
    return { ok: false, error: `ndiBufferPct must be between ${NDI_BUFFER_MIN} and ${NDI_BUFFER_MAX}.` }
  }

  const bureauBlockAdverse = b.bureauBlockAdverse
  if (typeof bureauBlockAdverse !== "boolean") {
    return { ok: false, error: "bureauBlockAdverse must be a boolean." }
  }

  return { ok: true, values: { bureauMinScore, bureauBlockAdverse, ndiBufferPct } }
}
