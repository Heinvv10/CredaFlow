import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"

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

/** A simulated check is fabricated evidence wherever this deployment forbids Experian simulation. */
export function simulatedBureauBlock(simulated: boolean): { blocked: boolean; reason?: string } {
  if (simulated && !isSimulationPermitted("experian")) {
    return { blocked: true, reason: SIMULATED_BUREAU_REASON }
  }
  return { blocked: false }
}
