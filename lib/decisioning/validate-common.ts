import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { DECLINE_CLIENT_REASONS } from "@/lib/applications/decline-category"
import { FACT_DEFINITIONS, FACT_NAMES, type FactDefinition, type FactName } from "./facts"
import type { Scalar } from "./types"

/** Collects problems with the path they were found at, then throws them all at once. */
export class Problems {
  readonly list: string[] = []
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`)
  }
  throwIfAny(): void {
    if (this.list.length > 0) throw new InvalidPayloadError(this.list)
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, problems: Problems): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) problems.add(path, `unknown key "${key}"`)
  }
}

export function factDefinition(name: unknown, path: string, problems: Problems): { name: FactName; def: FactDefinition } | null {
  if (typeof name !== "string" || !(FACT_NAMES as string[]).includes(name)) {
    problems.add(path, `unknown fact "${String(name)}"`)
    return null
  }
  return { name: name as FactName, def: FACT_DEFINITIONS[name as FactName] }
}

/** A scalar of the fact's type, from its closed list when it has one. */
export function checkScalar(value: unknown, def: FactDefinition, path: string, problems: Problems): value is Scalar {
  if (typeof value !== def.type || (typeof value === "number" && !Number.isFinite(value))) {
    problems.add(path, `expected a ${def.type}`)
    return false
  }
  if (def.values && !(def.values as readonly string[]).includes(value as string)) {
    problems.add(path, `must be one of ${def.values.join(", ")}`)
    return false
  }
  return true
}

/** A decline category the client can be told about: it needs wording, and a withdrawn application is not a decline. */
export function isDeclineCategory(value: unknown): boolean {
  return typeof value === "string" && value !== "WITHDRAWN" && DECLINE_CLIENT_REASONS[value as keyof typeof DECLINE_CLIENT_REASONS]?.length > 0
}

export const DECLINE_CATEGORY_HINT = "a decline category with client wording (not OTHER or WITHDRAWN)"

/** A calendar day, YYYY-MM-DD, that exists (not 2027-02-30). */
export const isDay = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
}
