import { defineSimulatedIntegrations } from "../define"

export default defineSimulatedIntegrations({
  /**
   * The simulated M-Pesa channel (lib/mobile-money/providers/simulated.ts).
   * Its callbacks book receipts for money that never moved, so a deployed
   * build may only run it when SIMULATED_INTEGRATIONS names it (the demo stacks).
   */
  "simulated-mpesa": {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const)
