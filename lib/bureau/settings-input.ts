/**
 * Validation for the tenant's bureau ENQUIRY settings (app/api/settings/bureau).
 * Pure — no I/O; the route and its tests share it.
 */
import { BUREAU_STALENESS_DAYS, isApprovalBureau } from "@/lib/compliance/bureau"
import type { BureauCredentials, BureauProvider } from "./types"

export interface BureauSettingsUpdate {
  bureauProviderOrder?: string[]
  bureauMaxAgeDays?: number
  /** Per provider: a full credential bag to store, or null to remove the stored one. */
  credentials?: Record<string, BureauCredentials | null>
}

export type BureauSettingsParseResult =
  | { ok: true; values: BureauSettingsUpdate }
  | { ok: false; error: string }

const MAX_CREDENTIAL_LENGTH = 4096

type Registry = Pick<BureauProvider, "id" | "credentialFields">

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function parseOrder(raw: unknown, registry: readonly Registry[]): string[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "bureauProviderOrder must be a non-empty list of bureau ids."
  const known = new Set(registry.map((p) => p.id))
  const order: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") return "bureauProviderOrder must contain bureau ids."
    const id = entry.trim().toLowerCase()
    if (!known.has(id)) return `Unknown bureau "${entry}".`
    if (order.includes(id)) return `Bureau "${id}" is listed twice.`
    order.push(id)
  }
  // The primary answers every origination enquiry; a bureau whose report
  // cannot support an approval would only ever be skipped.
  if (!isApprovalBureau(order[0])) {
    return `The primary bureau must be one that can support an approval; "${order[0]}" cannot yet (its score is not calibrated to the approval gate).`
  }
  return order
}

function parseCredentials(raw: unknown, registry: readonly Registry[]): Record<string, BureauCredentials | null> | string {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) return "credentials must map bureau ids to their credentials, or to null."
  const out: Record<string, BureauCredentials | null> = {}
  for (const [id, bag] of Object.entries(raw)) {
    const provider = registry.find((p) => p.id === id)
    if (!provider) return `Unknown bureau "${id}".`
    if (provider.credentialFields.length === 0) return `${id} does not take stored credentials.`
    if (bag === null) {
      out[id] = null
      continue
    }
    if (!isPlainObject(bag)) return `credentials.${id} must be an object or null.`
    const fields = new Set(provider.credentialFields)
    for (const key of Object.keys(bag)) {
      if (!fields.has(key)) return `credentials.${id} has an unknown field "${key}".`
    }
    const clean: BureauCredentials = {}
    for (const field of provider.credentialFields) {
      const value = bag[field]
      if (typeof value !== "string" || value.trim() === "") return `credentials.${id}.${field} is required.`
      if (value.length > MAX_CREDENTIAL_LENGTH) return `credentials.${id}.${field} is too long.`
      clean[field] = value.trim()
    }
    out[id] = clean
  }
  return out
}

export function parseBureauSettingsInput(body: unknown, registry: readonly Registry[]): BureauSettingsParseResult {
  if (!isPlainObject(body)) return { ok: false, error: "Invalid request body." }
  const allowed = new Set(["bureauProviderOrder", "bureauMaxAgeDays", "credentials"])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { ok: false, error: `Unknown setting "${key}".` }
  }
  const values: BureauSettingsUpdate = {}
  if (body.bureauProviderOrder !== undefined) {
    const order = parseOrder(body.bureauProviderOrder, registry)
    if (typeof order === "string") return { ok: false, error: order }
    values.bureauProviderOrder = order
  }
  if (body.bureauMaxAgeDays !== undefined) {
    const days = body.bureauMaxAgeDays
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > BUREAU_STALENESS_DAYS) {
      return { ok: false, error: `bureauMaxAgeDays must be a whole number from 1 to ${BUREAU_STALENESS_DAYS}.` }
    }
    values.bureauMaxAgeDays = days
  }
  if (body.credentials !== undefined) {
    const credentials = parseCredentials(body.credentials, registry)
    if (typeof credentials === "string") return { ok: false, error: credentials }
    values.credentials = credentials
  }
  if (Object.keys(values).length === 0) return { ok: false, error: "Nothing to update." }
  return { ok: true, values }
}
