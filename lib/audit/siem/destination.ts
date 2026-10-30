/**
 * Where a lender's SIEM forwarding may connect. The lender's admin types the
 * host, so it is untrusted (SSRF): by default only public addresses are
 * dialled (lib/lender-api/webhooks/ssrf.ts). A bank's SIEM is normally on a
 * private network, so the deployment's operator can opt in with
 * AUDIT_SIEM_ALLOW_PRIVATE=1, which admits RFC 1918 / ULA / CGNAT ranges. Loopback,
 * link-local (cloud metadata), unspecified and multicast are never admitted.
 *
 * The check runs inside the connection's own DNS lookup, so the address that
 * is checked is the address that is dialled (no DNS rebinding).
 */
import { BlockList, isIP } from "node:net"
import type { LookupAddress } from "node:dns"
import { embeddedIpv4, isBlockedAddress, SsrfError, systemResolver, type Resolver } from "@/lib/lender-api/webhooks/ssrf"

const never = new BlockList()
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4],
  // Other clouds' metadata services, which sit inside ranges the private opt-in admits (CGNAT, IETF protocol assignments).
  ["100.100.100.200", 32], ["192.0.0.192", 32],
] as const) {
  never.addSubnet(net, prefix, "ipv4")
}
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fe80::", 10], ["ff00::", 8],
  ["fd00:ec2::254", 128], // the AWS instance metadata service over IPv6, inside the ULA range the opt-in admits
] as const) never.addSubnet(net, prefix, "ipv6")

export function allowPrivateSiem(): boolean {
  return process.env.AUDIT_SIEM_ALLOW_PRIVATE === "1"
}

/** True when the SIEM client may dial `address`. */
export function siemAddressAllowed(address: string, allowPrivate: boolean = allowPrivateSiem()): boolean {
  if (!allowPrivate) return !isBlockedAddress(address)
  const family = isIP(address)
  if (family === 0) return false
  // An IPv4 address wrapped in IPv6 (mapped, NAT64, 6to4) is judged as that IPv4 address: ::ffff:127.0.0.1
  // and 64:ff9b::7f00:1 are loopback, not "an IPv6 address that is not on the list".
  if (family === 6) {
    const wrapped = embeddedIpv4(address)
    if (wrapped) return !never.check(wrapped, "ipv4")
    if (address.toLowerCase().startsWith("2002:")) return false
  }
  return !never.check(address, family === 4 ? "ipv4" : "ipv6")
}

/** Resolves `host` and requires every answer to be dialable; returns them. */
export async function resolveSiemHost(host: string, resolve: Resolver = systemResolver, allowPrivate?: boolean): Promise<LookupAddress[]> {
  const bare = host.replace(/^\[|\]$/g, "")
  const answers: LookupAddress[] = isIP(bare)
    ? [{ address: bare, family: isIP(bare) }]
    : await resolve(bare).catch((error: unknown) => {
        throw new SsrfError(`${bare} does not resolve (${error instanceof Error ? error.message : String(error)})`)
      })
  if (answers.length === 0) throw new SsrfError(`${bare} does not resolve`)
  const bad = answers.find((a) => !siemAddressAllowed(a.address, allowPrivate))
  if (bad) throw new SsrfError(`${bare} resolves to ${bad.address}, which the SIEM client may not dial`)
  return answers
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/** A `lookup` for tls.connect / https.request that only returns dialable addresses. */
export function siemLookup(resolve: Resolver = systemResolver, allowPrivate?: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback) => {
    resolveSiemHost(hostname, resolve, allowPrivate).then(
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
