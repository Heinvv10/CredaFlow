import type { ValuationProvider } from "./types"
import { csvGuideProvider } from "./providers/csv-guide"
import { syntheticValuationProvider } from "./providers/synthetic"

const providers = new Map<string, ValuationProvider>()

/** Providers self-register here; also a seam for test doubles. */
export function registerValuationProvider(provider: ValuationProvider): void {
  providers.set(provider.id, provider)
}

registerValuationProvider(csvGuideProvider)
// Refuses every read on a deployed build unless SIMULATED_INTEGRATIONS names
// "simulated-valuation-guide" (lib/integrations/simulation-guard.ts).
registerValuationProvider(syntheticValuationProvider)

export function getValuationProvider(id: string): ValuationProvider | null {
  return providers.get(id) ?? null
}

export function registeredValuationProviderIds(): string[] {
  return [...providers.keys()]
}
