import { defineSimulatedIntegrations } from "../define"

export default defineSimulatedIntegrations({
  /** The fixture payout channel (lib/payouts/providers/simulated.ts): it
   *  reports money paid that never moved. */
  "simulated-payout": {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const)
