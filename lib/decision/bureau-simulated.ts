import { isSimulationPermitted, type GuardedIntegration } from "@/lib/integrations/simulation-guard"

export const SIMULATED_BUREAU_REASON =
  "The bureau check is a simulated result and is not valid evidence in this environment."

/** True when the stored check came from a simulated (dry-run) provider response. */
export function isSimulatedBureauCheck(obligations: unknown): boolean {
  return (
    typeof obligations === "object" &&
    obligations !== null &&
    (obligations as { simulated?: unknown }).simulated === true
  )
}

/** Simulation-guard keys a stored bureau check may name as its source. */
const BUREAU_SIMULATION_SOURCES: ReadonlySet<string> = new Set<GuardedIntegration>([
  "experian",
  "transunion",
  "simulated-bureau",
])

/**
 * The policy that governs a simulated check: `obligations.simulationSource`
 * (lib/bureau/persist.ts). Rows written before the bureau framework carry no
 * source and came from the Experian dry-run. A source this code does not know
 * returns null, which no policy permits.
 */
function simulationSource(obligations: unknown): GuardedIntegration | null {
  const source = (obligations as { simulationSource?: unknown }).simulationSource
  if (source === undefined) return "experian"
  return typeof source === "string" && BUREAU_SIMULATION_SOURCES.has(source) ? (source as GuardedIntegration) : null
}

/** The simulated bureau's provider id (lib/bureau/providers/simulated.ts). */
const SIMULATED_PROVIDER = "simulated"

/**
 * A simulated check is fabricated evidence wherever this deployment forbids
 * simulation by the provider that produced it. Reads the stored check's
 * `obligations` JSON (the marker and its source) and its `provider`: a row
 * from the simulated bureau is governed by that bureau's policy whatever its
 * marker says, so a missing or altered marker cannot launder it.
 */
export function simulatedBureauBlock(
  check: { obligations?: unknown; provider?: string | null } | null | undefined,
): { blocked: boolean; reason?: string } {
  const obligations = check?.obligations
  if (check?.provider === SIMULATED_PROVIDER) {
    return isSimulationPermitted("simulated-bureau") ? { blocked: false } : { blocked: true, reason: SIMULATED_BUREAU_REASON }
  }
  if (!isSimulatedBureauCheck(obligations)) return { blocked: false }
  const source = simulationSource(obligations)
  if (source === null || !isSimulationPermitted(source)) {
    return { blocked: true, reason: SIMULATED_BUREAU_REASON }
  }
  return { blocked: false }
}
