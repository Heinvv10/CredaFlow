import { afterEach, describe, expect, it } from "vitest"
import { parseCredentialAllowlist, sourceAddressAllowed } from "./ip-restriction"

const from = (xff?: string) => new Request("http://localhost/api/v1/clients", { headers: xff ? { "x-forwarded-for": xff } : {} })
afterEach(() => { delete process.env.TRUSTED_PROXY })

describe("parseCredentialAllowlist", () => {
  it("accepts nothing, a list, or a text list, and normalises", () => {
    expect(parseCredentialAllowlist(undefined)).toEqual({ ok: true, entries: [] })
    expect(parseCredentialAllowlist("")).toEqual({ ok: true, entries: [] })
    expect(parseCredentialAllowlist(["10.0.0.0/8", " 2001:DB8::/32 "])).toEqual({ ok: true, entries: ["10.0.0.0/8", "2001:db8::/32"] })
    expect(parseCredentialAllowlist("203.0.113.5\n198.51.100.0/24")).toEqual({ ok: true, entries: ["203.0.113.5", "198.51.100.0/24"] })
  })
  it.each([["not an ip"], ["10.0.0.0/33"], [["10.0.0.1", 5]], [{ a: 1 }]])("refuses %j", (value) => {
    expect(parseCredentialAllowlist(value).ok).toBe(false)
  })
})

describe("sourceAddressAllowed", () => {
  it("allows everyone when no allowlist is set, even with no readable address", () => {
    expect(sourceAddressAllowed(from(), [])).toBe(true)
  })
  it("matches the trusted-proxy caller address against the allowlist", () => {
    process.env.TRUSTED_PROXY = "1"
    expect(sourceAddressAllowed(from("198.51.100.7"), ["198.51.100.0/24"])).toBe(true)
    expect(sourceAddressAllowed(from("203.0.113.9"), ["198.51.100.0/24"])).toBe(false)
  })
  it("ignores a spoofed left-most X-Forwarded-For hop", () => {
    process.env.TRUSTED_PROXY = "1"
    expect(sourceAddressAllowed(from("198.51.100.7, 203.0.113.9"), ["198.51.100.0/24"])).toBe(false)
  })
  it("refuses when the caller address is unknown (TRUSTED_PROXY unset) and an allowlist is set", () => {
    expect(sourceAddressAllowed(from("198.51.100.7"), ["198.51.100.0/24"])).toBe(false)
  })
})
