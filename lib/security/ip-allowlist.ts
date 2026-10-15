/**
 * Per-lender staff IP allowlist (TenantConfig.staffIpAllowlist): CIDR blocks
 * or bare addresses, IPv4 and IPv6. Matching uses node's BlockList, so no
 * hand-rolled bit arithmetic. The caller's address comes from callerIp()
 * (lib/rate-limit.ts), the one place the app derives a client IP.
 */
import { BlockList, isIP } from "node:net"

const MAX_ENTRIES = 50

type Entry = { address: string; prefix: number; family: "ipv4" | "ipv6" }

function parseEntry(raw: string): Entry | null {
  const [address, prefixText, ...rest] = raw.split("/")
  if (rest.length > 0) return null
  const version = isIP(address)
  if (version === 0) return null
  const max = version === 4 ? 32 : 128
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null
  const prefix = prefixText === undefined ? max : Number(prefixText)
  if (prefix > max) return null
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" }
}

export type ParsedAllowlist = { ok: true; entries: string[] } | { ok: false; error: string }

/** Validates an allowlist from the settings form: an array or a newline/comma list. */
export function parseIpAllowlist(value: unknown): ParsedAllowlist {
  const items = typeof value === "string" ? value.split(/[\n,]/) : value
  if (!Array.isArray(items) || items.some((i) => typeof i !== "string")) {
    return { ok: false, error: "The IP allowlist must be a list of addresses or CIDR blocks." }
  }
  const entries = (items as string[]).map((i) => i.trim().toLowerCase()).filter((i) => i.length > 0)
  if (entries.length > MAX_ENTRIES) {
    return { ok: false, error: `The IP allowlist takes at most ${MAX_ENTRIES} entries.` }
  }
  const invalid = entries.find((e) => parseEntry(e) === null)
  if (invalid !== undefined) {
    return { ok: false, error: `Not an IP address or CIDR block: ${invalid}` }
  }
  return { ok: true, entries }
}

/**
 * True when `ip` falls inside any entry. An unreadable address (callerIp's
 * "unknown", or null) never matches, so a restricted tenant fails closed
 * when no trusted proxy reports the caller.
 */
export function ipInAllowlist(ip: string | null | undefined, allowlist: readonly string[]): boolean {
  if (!ip) return false
  // BlockList matches an IPv4-mapped IPv6 caller (::ffff:192.0.2.1) against
  // IPv4 blocks itself (pinned in ip-allowlist.test.ts).
  const address = ip.trim()
  const version = isIP(address)
  if (version === 0) return false
  const blocks = new BlockList()
  for (const raw of allowlist) {
    const entry = parseEntry(raw.trim().toLowerCase())
    if (entry) blocks.addSubnet(entry.address, entry.prefix, entry.family)
  }
  return blocks.check(address, version === 4 ? "ipv4" : "ipv6")
}
