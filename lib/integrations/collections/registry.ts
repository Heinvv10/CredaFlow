import {
  CollectionProviderError,
  type CollectionConfig,
  type CollectionProvider,
} from "./types"
import { netcashCollections } from "./netcash"
import { simulatedCollections } from "./simulated"

const providers = new Map<string, CollectionProvider>()

/** Adapters self-register here; also a seam for test doubles. */
export function registerProvider(p: CollectionProvider): void {
  providers.set(p.id, p)
}

registerProvider(netcashCollections)
// Refuses every call on a deployed build unless SIMULATED_INTEGRATIONS names
// "simulated-collections" (lib/integrations/simulation-guard.ts).
registerProvider(simulatedCollections)

function resolve(key: string | null): CollectionProvider {
  if (!key) {
    throw new CollectionProviderError(
      "NOT_CONFIGURED",
      "No collection provider configured for this tenant (Settings → Integrations → Collections)"
    )
  }
  const provider = providers.get(key)
  if (!provider) {
    throw new CollectionProviderError("UNKNOWN_PROVIDER", `Unknown collection provider "${key}"`)
  }
  return provider
}

export function getCollectionProvider(cfg: CollectionConfig): CollectionProvider {
  return resolve(cfg.collectionProvider)
}

export function getAvsProvider(cfg: CollectionConfig): CollectionProvider {
  return resolve(cfg.avsProvider ?? cfg.collectionProvider)
}
