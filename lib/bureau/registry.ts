import { BureauProviderError, type BureauProvider } from "./types"
import { experianBureau } from "./providers/experian"
import { transunionBureau } from "./providers/transunion"
import { simulatedBureau } from "./providers/simulated"
import { SKELETON_BUREAUS } from "./providers/skeletons"

const providers = new Map<string, BureauProvider>()

/** Adapters self-register here; also a seam for test doubles. */
export function registerBureauProvider(provider: BureauProvider): void {
  providers.set(provider.id, provider)
}

for (const provider of [experianBureau, transunionBureau, simulatedBureau, ...SKELETON_BUREAUS]) {
  registerBureauProvider(provider)
}

export function getBureauProvider(id: string): BureauProvider | null {
  return providers.get(id) ?? null
}

export function registeredBureauIds(): string[] {
  return [...providers.keys()]
}

/**
 * The tenant's enquiry order: `TenantConfig.bureauProviderOrder`, primary
 * first, then the fallbacks. Blank and repeated entries are dropped (a repeat
 * would bill the same bureau twice for one enquiry). Unknown ids are KEPT so
 * the run records them as a failed attempt instead of silently skipping a
 * bureau the lender believes is configured.
 */
export function bureauProviderOrder(config: { bureauProviderOrder: readonly string[] | null } | null): string[] {
  const seen = new Set<string>()
  for (const raw of config?.bureauProviderOrder ?? []) {
    const id = raw.trim().toLowerCase()
    if (id) seen.add(id)
  }
  if (seen.size === 0) {
    throw new BureauProviderError(
      "NOT_CONFIGURED",
      "No credit bureau is enabled for this tenant (TenantConfig.bureauProviderOrder is empty)",
    )
  }
  return [...seen]
}
