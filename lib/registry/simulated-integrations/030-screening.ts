import { defineSimulatedIntegrations } from "../define"

export default defineSimulatedIntegrations({
  /**
   * PEP / sanctions screening (lib/screening/simulated-provider.ts). A
   * simulated "clear" would wave a sanctioned person through, so it is refused
   * on a deployed build unless listed in SIMULATED_INTEGRATIONS.
   */
  screening: {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const)
