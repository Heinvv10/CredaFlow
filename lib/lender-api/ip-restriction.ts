import { callerIp } from "@/lib/rate-limit"
import { ipInAllowlist, parseIpAllowlist } from "@/lib/security/ip-allowlist"

/**
 * Optional source-address allowlist of one API key or OAuth client (CIDR blocks,
 * the same rules as the staff allowlist, lib/security/ip-allowlist.ts). Empty
 * means no restriction. The caller is `callerIp` (the X-Forwarded-For hop the
 * TRUSTED_PROXY trusted proxies appended): with an allowlist set and no
 * readable caller address ("unknown", TRUSTED_PROXY unset) the request is
 * refused, never waved through.
 */

export function parseCredentialAllowlist(value: unknown): { ok: true; entries: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, entries: [] }
  return parseIpAllowlist(value)
}

export function sourceAddressAllowed(req: Request, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  return ipInAllowlist(callerIp(req), allowlist)
}
