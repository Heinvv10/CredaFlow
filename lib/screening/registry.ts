import { SCREENING_TYPES, ScreeningProviderError, type ScreeningProvider, type ScreeningType } from "./types"
import { simulatedScreeningProvider } from "./simulated-provider"

/**
 * Screening providers by key. TenantConfig.screeningProvider names one; null
 * means screening is not configured for that lender. Real adapters register
 * here once a provider is contracted. NO provider-specific code outside its
 * adapter file (lib/integrations/.claude.md).
 */
const providers = new Map<string, ScreeningProvider>()

/** Adapters self-register here; also a seam for test doubles. */
export function registerScreeningProvider(p: ScreeningProvider): void {
  providers.set(p.id, p)
}

registerScreeningProvider(simulatedScreeningProvider)

export function listScreeningProviders(): Array<{ id: string; label: string; simulated: boolean }> {
  return [...providers.values()].map((p) => ({ id: p.id, label: p.label, simulated: p.simulated }))
}

/** The types a run of this provider records; every type when the provider is unknown. */
export function expectedTypesFor(key: string | null): readonly ScreeningType[] {
  return (key && providers.get(key)?.supportedTypes) || SCREENING_TYPES
}

export function isKnownScreeningProvider(key: unknown): key is string {
  return typeof key === "string" && providers.has(key)
}

export function getScreeningProvider(key: string | null): ScreeningProvider {
  if (!key) {
    throw new ScreeningProviderError(
      "NOT_CONFIGURED",
      "No screening provider configured for this lender (Compliance → Screening)",
    )
  }
  const provider = providers.get(key)
  if (!provider) {
    throw new ScreeningProviderError("UNKNOWN_PROVIDER", `Unknown screening provider "${key}"`)
  }
  return provider
}
