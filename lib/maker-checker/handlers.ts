import { decisionEngineConfigHandler, decisionRuleSetHandler } from "@/lib/decisioning/change-handlers"
import type { ChangeHandler } from "./types"

// One entry per kind of change. A new consumer adds its handler import and one
// line to this map (lib/maker-checker/.claude.md, "Adding a kind").
const HANDLERS: Record<string, ChangeHandler<never>> = {
  [decisionRuleSetHandler.kind]: decisionRuleSetHandler as ChangeHandler<never>,
  [decisionEngineConfigHandler.kind]: decisionEngineConfigHandler as ChangeHandler<never>,
}

export function handlerFor(kind: string): ChangeHandler<unknown> | null {
  return (HANDLERS[kind] as ChangeHandler<unknown> | undefined) ?? null
}

export function registeredKinds(): string[] {
  return Object.keys(HANDLERS)
}
