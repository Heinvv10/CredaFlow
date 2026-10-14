import { describe, expect, it } from "vitest"
import { ipInAllowlist, parseIpAllowlist } from "./ip-allowlist"

// RFC 5737 / RFC 3849 documentation ranges only.
describe("ipInAllowlist", () => {
  const list = ["192.0.2.0/24", "198.51.100.7", "2001:db8:abcd::/48"]

  it("matches IPv4 inside a CIDR block and rejects the neighbours", () => {
    expect(ipInAllowlist("192.0.2.0", list)).toBe(true)
    expect(ipInAllowlist("192.0.2.255", list)).toBe(true)
    expect(ipInAllowlist("192.0.3.0", list)).toBe(false)
    expect(ipInAllowlist("192.0.1.255", list)).toBe(false)
  })

  it("treats a bare address as a single host", () => {
    expect(ipInAllowlist("198.51.100.7", list)).toBe(true)
    expect(ipInAllowlist("198.51.100.8", list)).toBe(false)
  })

  it("matches IPv6 inside a prefix, in any textual form", () => {
    expect(ipInAllowlist("2001:db8:abcd:12::1", list)).toBe(true)
    expect(ipInAllowlist("2001:0db8:abcd:0000:0000:0000:0000:0001", list)).toBe(true)
    expect(ipInAllowlist("2001:db8:abce::1", list)).toBe(false)
  })

  it("matches an IPv4-mapped IPv6 caller against an IPv4 block", () => {
    expect(ipInAllowlist("::ffff:192.0.2.10", list)).toBe(true)
    expect(ipInAllowlist("::ffff:203.0.113.1", list)).toBe(false)
  })

  it("never matches an address it cannot read", () => {
    expect(ipInAllowlist("unknown", list)).toBe(false)
    expect(ipInAllowlist("", list)).toBe(false)
    expect(ipInAllowlist(null, list)).toBe(false)
  })

  it("matches nothing against an empty list (callers treat empty as no restriction)", () => {
    expect(ipInAllowlist("192.0.2.1", [])).toBe(false)
  })

  it("supports /0 only if configured explicitly", () => {
    expect(ipInAllowlist("203.0.113.9", ["0.0.0.0/0"])).toBe(true)
  })
})

describe("parseIpAllowlist", () => {
  it("normalises entries and drops blanks", () => {
    expect(parseIpAllowlist(["  192.0.2.0/24 ", "", "2001:DB8::/32"])).toEqual({
      ok: true,
      entries: ["192.0.2.0/24", "2001:db8::/32"],
    })
  })

  it("accepts a newline- or comma-separated string", () => {
    expect(parseIpAllowlist("192.0.2.1\n198.51.100.0/24, 203.0.113.5")).toEqual({
      ok: true,
      entries: ["192.0.2.1", "198.51.100.0/24", "203.0.113.5"],
    })
  })

  it("refuses an invalid address or prefix, naming it", () => {
    for (const bad of ["192.0.2.0/33", "2001:db8::/129", "192.0.2.300", "example.com", "192.0.2.0/", "/24", "192.0.2.0/-1"]) {
      const parsed = parseIpAllowlist([bad])
      expect(parsed.ok, bad).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain(bad.trim())
    }
  })

  it("refuses more than 50 entries", () => {
    const many = Array.from({ length: 51 }, (_, i) => `192.0.2.${i}`)
    expect(parseIpAllowlist(many).ok).toBe(false)
  })
})
