import { describe, expect, it } from "vitest"
import { apiKeyMatches, apiKeyPrefix, apiKeyState, bearerToken, generateApiKey, hashApiKey, isApiKeyLifetime } from "./keys"
import { hasScope, parseScopes } from "./scopes"

describe("API key generation and hashing", () => {
  it("produces a well-formed key whose stored form is only its prefix and SHA-256", () => {
    const g = generateApiKey()
    expect(g.key).toMatch(/^cfk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/)
    expect(apiKeyPrefix(g.key)).toBe(g.prefix)
    expect(g.keyHash).toBe(hashApiKey(g.key))
    expect(g.keyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(g.keyHash.includes(g.key.slice(17))).toBe(false)
    expect(generateApiKey().key).not.toBe(g.key)
  })

  it("matches only the exact key", () => {
    const g = generateApiKey()
    expect(apiKeyMatches(g.key, g.keyHash)).toBe(true)
    const last = g.key.at(-1) === "A" ? "B" : "A"
    expect(apiKeyMatches(g.key.slice(0, -1) + last, g.keyHash)).toBe(false)
    expect(apiKeyMatches(g.key, "00")).toBe(false)
  })

  it("rejects malformed keys and headers", () => {
    expect(apiKeyPrefix("cfk_ABCDEF000000_" + "a".repeat(43))).toBeNull()
    expect(apiKeyPrefix("cfk_000000000000_short")).toBeNull()
    expect(bearerToken("Bearer abc")).toBe("abc")
    expect(bearerToken("bearer   abc  ")).toBe("abc")
    expect(bearerToken("Basic abc")).toBeNull()
    expect(bearerToken("Bearer a b")).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })
})

describe("API key state", () => {
  const now = new Date("2026-10-14T10:00:00Z")
  it("is active until it expires, and revoked wins", () => {
    expect(apiKeyState({ revokedAt: null, expiresAt: new Date("2026-10-14T10:00:01Z") }, now)).toBe("active")
    expect(apiKeyState({ revokedAt: null, expiresAt: now }, now)).toBe("expired")
    expect(apiKeyState({ revokedAt: new Date("2026-10-01"), expiresAt: new Date("2027-01-01") }, now)).toBe("revoked")
  })
  it("offers fixed lifetimes only", () => {
    expect(isApiKeyLifetime(365)).toBe(true)
    expect(isApiKeyLifetime(3650)).toBe(false)
    expect(isApiKeyLifetime("30")).toBe(false)
  })
})

describe("scopes", () => {
  it("parses a non-empty list of known scopes, de-duplicated", () => {
    expect(parseScopes(["loans:read", "loans:read", "pii:read"])).toEqual(["loans:read", "pii:read"])
    expect(parseScopes([])).toBeNull()
    expect(parseScopes(["loans:write"])).toBeNull()
    expect(parseScopes("loans:read")).toBeNull()
  })
  it("grants only what is listed", () => {
    expect(hasScope(["loans:read"], "loans:read")).toBe(true)
    expect(hasScope(["loans:read"], "pii:read")).toBe(false)
  })
})
