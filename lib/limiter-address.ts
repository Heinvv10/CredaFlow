import { isIP } from "node:net"

/**
 * The address a rate-limit key is built from. IPv4 is the whole address. IPv6 is its /64: one subscriber, or one
 * hosting customer, is routinely handed a whole /64, so keying on the full address would let a single attacker
 * rotate through 2^64 addresses and get a fresh budget (and a fresh row in the shared store) for each. An IPv4-mapped
 * IPv6 address (::ffff:a.b.c.d) is the IPv4 address it carries; anything that is not an address ("unknown") is kept.
 *
 * Used for the key only: records (audit rows, login logs) keep the full address (callerIp / recordedCallerIp).
 */
export function limiterAddress(ip: string): string {
  const family = isIP(ip)
  if (family === 4) return ip
  if (family !== 6) return ip
  const hextets = expandIpv6(ip)
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return `${hextets[6]! >> 8}.${hextets[6]! & 255}.${hextets[7]! >> 8}.${hextets[7]! & 255}`
  }
  return `${hextets.slice(0, 4).map((h) => h.toString(16)).join(":")}::/64`
}

/** The eight 16-bit groups of a valid IPv6 address (zone id and an embedded IPv4 tail handled). */
function expandIpv6(ip: string): number[] {
  let text = ip.split("%")[0]!
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number)
    text = text.slice(0, dotted.index) + `${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`
  }
  const [head, tail] = text.split("::")
  const part = (s: string | undefined) => (s ? s.split(":").map((h) => parseInt(h, 16)) : [])
  const headGroups = part(head)
  const tailGroups = tail === undefined ? [] : part(tail)
  const zeros = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length
  return [...headGroups, ...Array.from({ length: zeros }, () => 0), ...tailGroups]
}
