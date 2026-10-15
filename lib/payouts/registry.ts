import { netcashPayouts } from "./providers/netcash"
import { capitecPayPayouts, cashVoucherPayouts, payShapPayouts } from "./providers/not-implemented"
import { simulatedPayouts } from "./providers/simulated"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { PayoutProviderError, type PayoutProvider } from "./types"

const providers = new Map<string, PayoutProvider>()

/** Adapters register here; also the seam for test doubles. */
export function registerPayoutProvider(provider: PayoutProvider): void {
  providers.set(provider.id, provider)
}

for (const provider of [netcashPayouts, simulatedPayouts, capitecPayPayouts, payShapPayouts, cashVoucherPayouts]) {
  registerPayoutProvider(provider)
}

export function registeredPayoutProviders(): PayoutProvider[] {
  return [...providers.values()]
}

export function findPayoutProvider(id: string): PayoutProvider | null {
  return providers.get(id) ?? null
}

/** Why this provider may not be used here, or null. A simulating channel needs the guard's permission. */
export function payoutProviderRefusal(provider: PayoutProvider): string | null {
  if (!provider.capabilities.implemented) return `${provider.displayName} payouts are not implemented yet`
  const simulation = provider.simulation()
  if (simulation && !isSimulationPermitted(simulation)) {
    return `${provider.displayName} would only simulate payouts here, and this deployment does not permit "${simulation}" simulation`
  }
  return null
}

/** The tenant's configured provider, refused unless it is a real adapter that may run here. */
export function getPayoutProvider(id: string | null): PayoutProvider {
  if (!id) {
    throw new PayoutProviderError("NOT_CONFIGURED", "No payout provider configured for this tenant (Settings → Integrations → Payouts)")
  }
  const provider = providers.get(id)
  if (!provider) throw new PayoutProviderError("UNKNOWN_PROVIDER", `Unknown payout provider "${id}"`)
  if (!provider.capabilities.implemented) {
    throw new PayoutProviderError("NOT_IMPLEMENTED", `${provider.displayName} payouts are not implemented yet`)
  }
  const refusal = payoutProviderRefusal(provider)
  if (refusal) throw new PayoutProviderError("SIMULATION_FORBIDDEN", refusal)
  return provider
}
