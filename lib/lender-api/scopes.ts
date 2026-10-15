/**
 * What an API key may do. Mirrored by the ApiKey_scopes_check constraint
 * (migration 20261014150000_lender_api_webhooks): change both together.
 */
export const API_SCOPES = [
  "clients:read",
  "applications:read",
  "applications:write",
  "loans:read",
  "payments:read",
  "pii:read",
] as const

export type ApiScope = (typeof API_SCOPES)[number]

export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  "clients:read": "Read clients (names, reference, masked ID number)",
  "applications:read": "Read loan applications",
  "applications:write": "Create draft loan applications",
  "loans:read": "Read loans and their repayment schedules",
  "payments:read": "Read payments received",
  "pii:read": "See full ID numbers, email, phone and date of birth",
}

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && (API_SCOPES as readonly string[]).includes(value)
}

/** The requested scopes, de-duplicated, or null if any is unknown or none given. */
export function parseScopes(value: unknown): ApiScope[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every(isApiScope)) return null
  return [...new Set(value)]
}

export function hasScope(granted: readonly string[], required: ApiScope): boolean {
  return granted.includes(required)
}
