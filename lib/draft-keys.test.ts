import { describe, it, expect } from "vitest"
import { DRAFT_TTL_MS, isDraftFresh } from "./draft-keys"

const NOW = Date.parse("2026-07-11T12:00:00.000Z")

describe("isDraftFresh", () => {
  it("is fresh just under the TTL boundary", () => {
    const updatedAt = new Date(NOW - (DRAFT_TTL_MS - 1)).toISOString()
    expect(isDraftFresh(updatedAt, NOW, DRAFT_TTL_MS)).toBe(true)
  })

  it("is stale exactly at and beyond the TTL boundary", () => {
    const atBoundary = new Date(NOW - DRAFT_TTL_MS).toISOString()
    expect(isDraftFresh(atBoundary, NOW, DRAFT_TTL_MS)).toBe(false)

    const wellPast = new Date(NOW - DRAFT_TTL_MS - 60_000).toISOString()
    expect(isDraftFresh(wellPast, NOW, DRAFT_TTL_MS)).toBe(false)
  })

  it("is stale when updatedAt is absent", () => {
    expect(isDraftFresh(undefined, NOW, DRAFT_TTL_MS)).toBe(false)
  })

  it("is stale when updatedAt is corrupt/unparseable", () => {
    expect(isDraftFresh("not-a-date", NOW, DRAFT_TTL_MS)).toBe(false)
  })

  it("defaults ttlMs to DRAFT_TTL_MS when not passed", () => {
    const justFresh = new Date(NOW - (DRAFT_TTL_MS - 1)).toISOString()
    expect(isDraftFresh(justFresh, NOW)).toBe(true)
  })
})
