import { defineSimulatedIntegrations } from "../define"

export default defineSimulatedIntegrations({
  /**
   * The simulated tracker provider (lib/telematics/providers/simulated.ts).
   * Its meter readings feed a lease's usage and excess, and its alerts raise
   * work items, so a deployed build may only run it when the environment
   * names it in SIMULATED_INTEGRATIONS (the demo stacks).
   */
  "simulated-telematics": {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const)
