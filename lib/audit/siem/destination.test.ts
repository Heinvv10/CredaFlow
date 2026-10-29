import { describe, expect, it } from "vitest"
import { resolveSiemHost, siemAddressAllowed } from "./destination"

describe("SIEM destination guard", () => {
  it("dials public addresses only by default", () => {
    expect(siemAddressAllowed("203.0.113.9", false)).toBe(false) // documentation range
    expect(siemAddressAllowed("8.8.8.8", false)).toBe(true)
    expect(siemAddressAllowed("10.1.2.3", false)).toBe(false)
    expect(siemAddressAllowed("192.168.1.5", false)).toBe(false)
    expect(siemAddressAllowed("127.0.0.1", false)).toBe(false)
  })

  it("admits private ranges when the operator opts in, but never loopback, link-local or multicast", () => {
    expect(siemAddressAllowed("10.1.2.3", true)).toBe(true)
    expect(siemAddressAllowed("172.20.0.4", true)).toBe(true)
    expect(siemAddressAllowed("fd12:3456::1", true)).toBe(true)
    expect(siemAddressAllowed("127.0.0.1", true)).toBe(false)
    expect(siemAddressAllowed("::1", true)).toBe(false)
    expect(siemAddressAllowed("169.254.169.254", true)).toBe(false)
    expect(siemAddressAllowed("fe80::1", true)).toBe(false)
    expect(siemAddressAllowed("::ffff:127.0.0.1", true)).toBe(false)
    expect(siemAddressAllowed("224.0.0.1", true)).toBe(false)
    expect(siemAddressAllowed("not-an-ip", true)).toBe(false)
  })

  it("judges an IPv4 address wrapped in IPv6 (mapped, NAT64, 6to4) as that IPv4 address, so private opt-in cannot reach loopback or metadata through it", () => {
    for (const wrapped of ["::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:0001::1", "2002:a9fe:a9fe::1", "::ffff:169.254.169.254"]) {
      expect(siemAddressAllowed(wrapped, true), wrapped).toBe(false)
      expect(siemAddressAllowed(wrapped, false), wrapped).toBe(false)
    }
    expect(siemAddressAllowed("::ffff:10.1.2.3", true)).toBe(true)
    expect(siemAddressAllowed("64:ff9b::a01:203", true)).toBe(true)
    expect(siemAddressAllowed("::ffff:10.1.2.3", false)).toBe(false)
  })

  it("refuses a name when any answer is not dialable (DNS may hand out either)", async () => {
    const resolve = async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }]
    await expect(resolveSiemHost("siem.example.invalid", resolve, false)).rejects.toThrow(/may not dial/)
    await expect(resolveSiemHost("siem.example.invalid", resolve, true)).resolves.toHaveLength(2)
  })

  it("refuses a name that does not resolve", async () => {
    await expect(resolveSiemHost("nx.invalid", async () => { throw new Error("ENOTFOUND") }, true)).rejects.toThrow(/does not resolve/)
  })
})
