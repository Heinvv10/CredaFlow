import { afterEach, describe, expect, it } from "vitest"
import { derivedKey } from "./derived-key"

const original = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET }
afterEach(() => {
  for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

describe("derivedKey", () => {
  it("is stable for a context and differs between contexts", () => {
    process.env.AUTH_SECRET = "a".repeat(40)
    expect(derivedKey("one").equals(derivedKey("one"))).toBe(true)
    expect(derivedKey("one").equals(derivedKey("two"))).toBe(false)
    expect(derivedKey("one")).toHaveLength(32)
  })

  it("changes with the secret", () => {
    process.env.AUTH_SECRET = "a".repeat(40)
    const first = derivedKey("one")
    process.env.AUTH_SECRET = "b".repeat(40)
    expect(derivedKey("one").equals(first)).toBe(false)
  })

  it("refuses to derive from a missing or short secret", () => {
    delete process.env.AUTH_SECRET
    delete process.env.NEXTAUTH_SECRET
    expect(() => derivedKey("one")).toThrow(/AUTH_SECRET/)
    process.env.AUTH_SECRET = "short"
    expect(() => derivedKey("one")).toThrow(/AUTH_SECRET/)
  })
})
