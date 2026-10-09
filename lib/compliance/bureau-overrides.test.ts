import { describe, it, expect } from "vitest"
import { parseFilter, buildWhere } from "./bureau-overrides"

function params(obj: Record<string, string>): URLSearchParams {
  return new URLSearchParams(obj)
}

describe("parseFilter", () => {
  it("returns all-null filter for empty params", () => {
    const f = parseFilter(params({}))
    expect(f).toEqual({ from: null, to: null, status: null })
  })

  it("parses valid ISO dates for from + to and shifts `to` forward by 24h", () => {
    const f = parseFilter(params({ from: "2026-05-01", to: "2026-05-21" }))
    expect(f.from).toEqual(new Date("2026-05-01T00:00:00.000Z"))
    expect(f.to).toEqual(new Date("2026-05-22T00:00:00.000Z"))
  })

  it("coerces malformed dates to null without throwing", () => {
    const f = parseFilter(params({ from: "not-a-date", to: "" }))
    expect(f.from).toBeNull()
    expect(f.to).toBeNull()
  })

  it("accepts a valid AppStatus value", () => {
    const f = parseFilter(params({ status: "APPROVED" }))
    expect(f.status).toBe("APPROVED")
  })

  it("coerces unknown status to null", () => {
    const f = parseFilter(params({ status: "BANANA" }))
    expect(f.status).toBeNull()
  })

  it("normalizes mid-day `to` timestamps to next-day UTC midnight", () => {
    const f = parseFilter(params({ to: "2026-05-21T15:30:00Z" }))
    expect(f.to).toEqual(new Date("2026-05-22T00:00:00.000Z"))
  })

  it("normalizes mid-day `from` timestamps to that day's UTC midnight", () => {
    const f = parseFilter(params({ from: "2026-05-01T15:30:00Z" }))
    expect(f.from).toEqual(new Date("2026-05-01T00:00:00.000Z"))
  })
})

describe("buildWhere", () => {
  const TENANT = "tenant-1"

  it("always pins tenantId and bureauOverrideAt: { not: null }", () => {
    const w = buildWhere(TENANT, { from: null, to: null, status: null })
    expect(w.tenantId).toBe(TENANT)
    expect(w.bureauOverrideAt).toEqual({ not: null })
  })

  it("merges `from` into bureauOverrideAt without losing the not-null guard", () => {
    const from = new Date("2026-05-01T00:00:00.000Z")
    const w = buildWhere(TENANT, { from, to: null, status: null })
    expect(w.bureauOverrideAt).toEqual({ not: null, gte: from })
  })

  it("merges `to` into bureauOverrideAt without losing the not-null guard", () => {
    const to = new Date("2026-05-22T00:00:00.000Z")
    const w = buildWhere(TENANT, { from: null, to, status: null })
    expect(w.bureauOverrideAt).toEqual({ not: null, lt: to })
  })

  it("merges both `from` and `to`", () => {
    const from = new Date("2026-05-01T00:00:00.000Z")
    const to = new Date("2026-05-22T00:00:00.000Z")
    const w = buildWhere(TENANT, { from, to, status: null })
    expect(w.bureauOverrideAt).toEqual({ not: null, gte: from, lt: to })
  })

  it("adds status when present", () => {
    const w = buildWhere(TENANT, { from: null, to: null, status: "APPROVED" })
    expect(w.status).toBe("APPROVED")
  })

  it("omits status when null", () => {
    const w = buildWhere(TENANT, { from: null, to: null, status: null })
    expect(w.status).toBeUndefined()
  })
})
