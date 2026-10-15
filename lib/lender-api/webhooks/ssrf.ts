import { BlockList, isIP } from "node:net"
import { lookup as dnsLookup } from "node:dns/promises"
import type { LookupAddress } from "node:dns"

/**
 * SSRF guard for outbound webhook URLs. A lender types the URL, so it is
 * untrusted: it must not reach this host, the docker network, the cloud
 * metadata endpoint or anything else that is not the public internet.
 *
 *   - https only, no credentials in the URL;
 *   - every address the name resolves to must be public (one private answer
 *     refuses the URL: a resolver may hand out either);
 *   - the check runs again INSIDE the connection's own DNS lookup
 *     (guardedLookup), so the address that is checked is the address that is
 *     dialled. Checking at save time and connecting later would let a name
 *     re-point to 127.0.0.1 in between (DNS rebinding).
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SsrfError"
  }
}

const blocked = new BlockList()
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4")
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  // Local-use NAT64 (RFC 8215), the documentation range (RFC 9637), ORCHIDv2 (RFC 7343).
  ["64:ff9b:1::", 48], ["3fff::", 20], ["2001:10::", 28], ["2001:20::", 28],
] as const) blocked.addSubnet(net, prefix, "ipv6")

/** The IPv4 address embedded in an IPv4-mapped, NAT64 or 6to4 IPv6 address. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase()
  const dotted = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (dotted) return dotted[1]
  const hex = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower)
  const pair = hex ?? sixToFour
  if (!pair) return null
  const hi = parseInt(pair[1], 16), lo = parseInt(pair[2], 16)
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".")
}

/** True for anything that is not a public unicast address. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, "ipv4")
  if (family === 6) {
    const v4 = embeddedIpv4(address)
    if (v4) return blocked.check(v4, "ipv4")
    if (address.toLowerCase().startsWith("2002:")) return true
    return blocked.check(address, "ipv6")
  }
  return true
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>

export const DNS_TIMEOUT_MS = 5_000

/** Fails a lookup that has not answered in `ms` (getaddrinfo itself has no deadline). */
export function withTimeout(resolve: Resolver, ms: number = DNS_TIMEOUT_MS): Resolver {
  return (hostname) => new Promise<LookupAddress[]>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`DNS lookup timed out after ${ms} ms`)), ms)
    resolve(hostname).then(
      (addresses) => { clearTimeout(timer); ok(addresses) },
      (error: unknown) => { clearTimeout(timer); fail(error) },
    )
  })
}

export const systemResolver: Resolver = withTimeout((hostname) => dnsLookup(hostname, { all: true, verbatim: true }))

/** Resolve and require every address to be public. Returns the addresses. */
export async function resolvePublic(hostname: string, resolve: Resolver): Promise<LookupAddress[]> {
  const bare = hostname.replace(/^\[|\]$/g, "")
  if (isIP(bare)) {
    if (isBlockedAddress(bare)) throw new SsrfError(`${bare} is not a public address`)
    return [{ address: bare, family: isIP(bare) }]
  }
  const addresses = await resolve(bare).catch((error: unknown) => {
    throw new SsrfError(`${bare} does not resolve (${error instanceof Error ? error.message : String(error)})`)
  })
  if (addresses.length === 0) throw new SsrfError(`${bare} does not resolve`)
  const bad = addresses.find((a) => isBlockedAddress(a.address))
  if (bad) throw new SsrfError(`${bare} resolves to ${bad.address}, which is not a public address`)
  return addresses
}

/** Parse and check a webhook URL (shape, then DNS). Returns the normalised URL. */
export async function assertWebhookUrl(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfError("not a valid URL")
  }
  if (url.protocol !== "https:") throw new SsrfError("the URL must use https")
  if (url.username || url.password) throw new SsrfError("the URL must not contain credentials")
  // Only the https port: other ports would let the URL probe services on public hosts.
  if (url.port !== "" && url.port !== "443") throw new SsrfError("the URL must use port 443")
  if (raw.length > 2048) throw new SsrfError("the URL is too long")
  await resolvePublic(url.hostname, resolve)
  return url
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/**
 * A `lookup` for http(s).request that only ever returns checked public
 * addresses. Handles both shapes Node asks for (`all: true` from
 * happy-eyeballs connects, a single address otherwise).
 */
export function guardedLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback) => {
    resolvePublic(hostname, resolve).then(
      (addresses) => {
        const wanted = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0
        const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses
        if (usable.length === 0) return callback(new SsrfError(`${hostname} has no usable address`), "", 0)
        if (options.all) return callback(null, usable)
        callback(null, usable[0].address, usable[0].family)
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    )
  }
}
