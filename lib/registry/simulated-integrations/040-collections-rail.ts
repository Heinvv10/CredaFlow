import { defineSimulatedIntegrations } from "../define"

export default defineSimulatedIntegrations({
  /**
   * The simulated collection rail (lib/integrations/collections/simulated.ts).
   * Its PAID outcome books a receipt, so a deployed build may only run it when
   * the environment names it in SIMULATED_INTEGRATIONS (the demo stacks).
   */
  "simulated-collections": {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const)
