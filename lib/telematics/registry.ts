import type { TelematicsProvider } from "./types"
import { simulatedTelematics } from "./providers/simulated"

const providers = new Map<string, TelematicsProvider>()

/** Adapters self-register here; also a seam for test doubles. */
export function registerTelematicsProvider(provider: TelematicsProvider): void {
  providers.set(provider.id, provider)
}

// Refuses every poll and registration on a deployed build unless
// SIMULATED_INTEGRATIONS names "simulated-telematics" (lib/integrations/simulation-guard.ts).
registerTelematicsProvider(simulatedTelematics)

export function getTelematicsProvider(id: string): TelematicsProvider | null {
  return providers.get(id) ?? null
}

export function registeredTelematicsProviderIds(): string[] {
  return [...providers.keys()]
}
