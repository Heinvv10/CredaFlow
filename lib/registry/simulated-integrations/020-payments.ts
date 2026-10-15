import { defineSimulatedIntegrations } from "../define"

export default defineSimulatedIntegrations({
  netcash: {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
  "netcash-collections": {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const)
