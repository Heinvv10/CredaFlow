import { describe, expect, it, vi } from "vitest"

vi.mock("crypto", () => ({
  randomInt: vi.fn(() => 0),
}))

import { generateReferralCodeCandidate, normaliseReferralCode, resolveReferralCodeById } from "./referrals"

describe("referral code format", () => {
  it("generates prefixed codes without hyphens by default", () => {
    expect(generateReferralCodeCandidate()).toBe("REFAAAAAA")
  })

  it("normalises codes without requiring separators", () => {
    expect(normaliseReferralCode(" acm5kv3bm ")).toBe("ACM5KV3BM")
  })
})

describe("resolveReferralCodeById", () => {
  it("returns null for a blank id without touching the DB", async () => {
    const findFirst = vi.fn()
    const result = await resolveReferralCodeById(
      { referralCode: { findFirst } } as never,
      { tenantId: "t1", id: null },
    )
    expect(result).toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("resolves by id gated on ACTIVE code AND ACTIVE agent", async () => {
    const code = { id: "code1", agentId: "agent1", agent: { status: "ACTIVE" } }
    const findFirst = vi.fn().mockResolvedValue(code)
    const result = await resolveReferralCodeById(
      { referralCode: { findFirst } } as never,
      { tenantId: "t1", id: "code1" },
    )
    expect(result).toBe(code)
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "code1", tenantId: "t1", status: "ACTIVE", agent: { status: "ACTIVE" } },
      include: { agent: true },
    })
  })

  it("returns null when a suspended agent/code fails the filter", async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const result = await resolveReferralCodeById(
      { referralCode: { findFirst } } as never,
      { tenantId: "t1", id: "code1" },
    )
    expect(result).toBeNull()
  })
})
