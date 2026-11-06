import { simulatedMpesa } from "./providers/simulated"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { MobileMoneyProviderError, type MobileMoneyProvider } from "./types"

const providers = new Map<string, MobileMoneyProvider>()

/** Adapters register here; also the seam for test doubles. */
export function registerMobileMoneyProvider(provider: MobileMoneyProvider): void {
  providers.set(provider.id, provider)
}

for (const provider of [simulatedMpesa]) {
  registerMobileMoneyProvider(provider)
}

/**
 * The provider an STK push goes through. Only the simulated one exists in this
 * slice; the Daraja adapter (KE-6) and a per-lender choice replace this.
 */
export const STK_PUSH_PROVIDER_ID = simulatedMpesa.id

export function findMobileMoneyProvider(id: string): MobileMoneyProvider | null {
  return providers.get(id) ?? null
}

/** Why this provider may not be used here, or null. A simulating channel needs the guard's permission. */
export function mobileMoneyProviderRefusal(provider: MobileMoneyProvider): string | null {
  const simulation = provider.simulation()
  if (simulation && !isSimulationPermitted(simulation)) {
    return `${provider.displayName} would only simulate M-Pesa payments here, and this deployment does not permit "${simulation}" simulation`
  }
  return null
}

/** The named provider, refused unless it may run here. */
export function getMobileMoneyProvider(id: string): MobileMoneyProvider {
  const provider = providers.get(id)
  if (!provider) throw new MobileMoneyProviderError("UNKNOWN_PROVIDER", `Unknown mobile-money provider "${id}"`)
  const refusal = mobileMoneyProviderRefusal(provider)
  if (refusal) throw new MobileMoneyProviderError("SIMULATION_FORBIDDEN", refusal)
  return provider
}
