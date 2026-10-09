/**
 * Pure AVS badge-state derivation for AvsStatusCard.
 *
 * Mirrors lib/avs.ts's evaluateAvsGate branch order exactly, but re-implemented
 * here rather than imported: that module also exports runAvsCheck, which pulls
 * in prisma (and transitively node:async_hooks) — Turbopack refuses to chunk
 * that into a client bundle even though only the pure helper is used.
 */
export type AvsLatest = {
  passed: boolean
  accountNumber: string
  createdAt: string
  subjectMatches: boolean
} | null

export type AvsCardState = "verified" | "failed" | "not_verified" | "account_changed"

export function deriveAvsState(
  latest: AvsLatest,
  currentAccountNumber: string | null
): AvsCardState {
  if (!currentAccountNumber) return "not_verified"
  if (!latest) return "not_verified"
  if (!latest.subjectMatches || latest.accountNumber !== currentAccountNumber) return "account_changed"
  if (!latest.passed) return "failed"
  return "verified"
}
