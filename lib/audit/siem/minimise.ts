/**
 * What of an AuditLog row leaves the building. A SIEM is a second copy of the
 * audit trail in another organisation's hands, so the default is the minimum a
 * SOC needs: what happened (action, entity, entityId), who (actor id, never the
 * email), where (tenant), when, and the chain position. oldValue / newValue /
 * source address go out only for actions on VALUE_ACTIONS (security and
 * configuration events, whose values are settings and reason codes, not
 * borrower data), and even then every field whose name says identity number,
 * account, income or credential, and every long digit run, is masked.
 */

/** Actions whose values (and source address) may be sent. */
export const VALUE_ACTIONS: RegExp =
  /^(SECURITY_|AUDIT_|STAFF_ACCESS_|STAFF_TOTP_|TOTP_|USER_(CREATED|UPDATED|DEACTIVATED|DELETED|WRITE_REFUSED)$|TENANT_(CREATED|SUSPENDED|REACTIVATED|COLOURS_UPDATED|LANGUAGES_UPDATED)$)/

const SENSITIVE_KEY = /(id.?number|idnum|passport|account|iban|branch.?code|sort.?code|card|pan$|income|salary|wage|earning|password|passwd|secret|token|key|pin$|otp|cert|email|phone|mobile|msisdn|address|birth|dob|name)/i
const MASK = "[masked]"
const MAX_DEPTH = 4
const MAX_ITEMS = 20
const MAX_STRING = 200

export function isValueAction(action: string): boolean {
  return VALUE_ACTIONS.test(action)
}

function maskString(value: string): string {
  // A hash or HMAC (the chain's own values) is not a number to hide.
  if (/^[0-9a-f]{32,128}$/i.test(value)) return value
  const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value
  // 6+ digits in a row (ID, account, card, phone) whatever the key was called.
  return clipped.replace(/\d{6,}/g, MASK)
}

export function maskValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return maskString(value)
  if (typeof value === "number" || typeof value === "boolean") return value
  if (depth >= MAX_DEPTH) return MASK
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => maskValue(v, depth + 1))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      out[k] = SENSITIVE_KEY.test(k) ? MASK : maskValue(v, depth + 1)
    }
    return out
  }
  return MASK
}
