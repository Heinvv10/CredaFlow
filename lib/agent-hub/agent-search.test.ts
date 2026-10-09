import { describe, it, expect } from "vitest"
import { matchesAgentSearch, type SearchableAgent } from "./agent-search"

function agent(overrides: Partial<SearchableAgent> = {}): SearchableAgent {
  return {
    displayName: "Thabo Nkosi",
    email: "thabo@example.com",
    phone: "0821234567",
    referralCodes: [{ code: "THABO01" }],
    ...overrides,
  }
}

describe("matchesAgentSearch", () => {
  it("matches on displayName, case-insensitively", () => {
    expect(matchesAgentSearch(agent(), "thabo")).toBe(true)
    expect(matchesAgentSearch(agent(), "NKOSI")).toBe(true)
  })

  it("matches on email", () => {
    expect(matchesAgentSearch(agent(), "example.com")).toBe(true)
  })

  it("matches on phone", () => {
    expect(matchesAgentSearch(agent(), "0821234")).toBe(true)
  })

  it("matches on a referral code value", () => {
    expect(matchesAgentSearch(agent(), "thabo01")).toBe(true)
  })

  it("matches when any one of several codes matches", () => {
    const multi = agent({ referralCodes: [{ code: "TF-AAAAAA" }, { code: "CAMPAIGN2026" }] })
    expect(matchesAgentSearch(multi, "campaign2026")).toBe(true)
  })

  it("returns false when nothing matches", () => {
    expect(matchesAgentSearch(agent(), "zzz-no-match")).toBe(false)
  })

  it("treats a blank query as matching everything", () => {
    expect(matchesAgentSearch(agent(), "")).toBe(true)
    expect(matchesAgentSearch(agent(), "   ")).toBe(true)
  })

  it("does not throw when email or phone is null", () => {
    const noContact = agent({ email: null, phone: null })
    expect(matchesAgentSearch(noContact, "thabo")).toBe(true)
    expect(matchesAgentSearch(noContact, "0821234")).toBe(false)
  })

  it("does not match a substring split across two different fields", () => {
    // "thaboexample" spans displayName + email but is not a substring of either field alone.
    expect(matchesAgentSearch(agent(), "thaboexample")).toBe(false)
  })
})
