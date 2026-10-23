import { defineSimulatedIntegrations } from "../define"

export default defineSimulatedIntegrations({
  /**
   * The synthetic valuation guide (lib/valuation-guides/providers/synthetic.ts).
   * Its values reach a deal's LTV and the book revaluation, so a deployed
   * build may only load it when the environment names it in
   * SIMULATED_INTEGRATIONS (the demo stacks).
   */
  "simulated-valuation-guide": {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const)
