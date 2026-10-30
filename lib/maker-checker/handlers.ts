import { CHANGE_HANDLERS } from "@/lib/registry/generated/change-handlers"
import type { ChangeHandler } from "./types"

// The kinds of change are registered in lib/registry/change-handlers/ (one file per
// consumer; docs/ARCHITECTURE.md, "Registries"); this module never names a consumer.
export function handlerFor(kind: string): ChangeHandler<unknown> | null {
  return (CHANGE_HANDLERS[kind] as unknown as ChangeHandler<unknown> | undefined) ?? null
}

export function registeredKinds(): string[] {
  return Object.keys(CHANGE_HANDLERS)
}
