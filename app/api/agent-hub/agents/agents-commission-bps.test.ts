import { describe, it, expect, vi } from "vitest"

// This module imports `@/lib/auth-guards`, which pulls in `@/lib/auth`
// (next-auth) at module load time — mock it so importing the route for
// its pure `parseCommissionBps` helper doesn't require a real auth setup.
// Same pattern as every other route test in this repo that touches
// `@/lib/auth-guards` (e.g. app/api/insurance/policies/[id]/route.test.ts).
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example" },
  }),
}))

import { parseCommissionBps } from "./commission"

describe("parseCommissionBps", () => {
  it("accepts an integer in [0, 10000]", () => {
    expect(parseCommissionBps(250)).toEqual({ ok: true, value: 250 })
    expect(parseCommissionBps(0)).toEqual({ ok: true, value: 0 })
  })
  it("accepts null to clear the override", () => {
    expect(parseCommissionBps(null)).toEqual({ ok: true, value: null })
  })
  it("rejects out-of-range or non-integer", () => {
    expect(parseCommissionBps(-1).ok).toBe(false)
    expect(parseCommissionBps(10001).ok).toBe(false)
    expect(parseCommissionBps(2.5).ok).toBe(false)
    expect(parseCommissionBps("x").ok).toBe(false)
  })
})
