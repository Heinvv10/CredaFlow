import { describe, expect, it } from "vitest"
import { canonicalJson } from "./canonical-json"

describe("canonicalJson", () => {
  it("is key-order independent — the jsonb round-trip property", () => {
    // Postgres jsonb reorders keys (length, then bytewise); equality checks
    // against stored rows must not depend on insertion order.
    const written = { schedule: [{ dueAtIso: "2026-08-01", amountCents: 100 }], version: "v1" }
    const roundTripped = { version: "v1", schedule: [{ amountCents: 100, dueAtIso: "2026-08-01" }] }
    expect(canonicalJson(written)).toBe(canonicalJson(roundTripped))
  })

  it("still detects a changed VALUE", () => {
    expect(canonicalJson({ a: 1, b: 2 })).not.toBe(canonicalJson({ a: 1, b: 3 }))
  })

  it("preserves array order — arrays are sequences, not sets", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it("sorts keys by code unit, not locale — digests must be machine-stable", () => {
    // Under en-ZA localeCompare "a" sorts before "B"; code-unit order puts
    // "B" (0x42) first. A locale-dependent order would make the same value
    // hash differently between machines.
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}')
  })

  it("serialises primitives and null like JSON.stringify", () => {
    expect(canonicalJson(null)).toBe("null")
    expect(canonicalJson("x")).toBe('"x"')
    expect(canonicalJson(7)).toBe("7")
    expect(canonicalJson(undefined)).toBe("null")
  })
})
