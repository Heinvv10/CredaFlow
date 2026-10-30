import { defineChangeHandlers } from "../define"

// The kinds of change lib/maker-checker/ applies (docs/ARCHITECTURE.md, "Registries").
export default defineChangeHandlers([
  { kind: "DECISION_RULE_SET", module: "@/lib/decisioning/change-handlers", export: "decisionRuleSetHandler" },
  { kind: "DECISION_ENGINE_CONFIG", module: "@/lib/decisioning/change-handlers", export: "decisionEngineConfigHandler" },
] as const)
