import { describe, it, expect } from "vitest"
import { toReferralCodeOptions } from "./referral-agent-options"

// Built so an ACTIVE/ACTIVE pair is the ONLY one that survives: every other
// agent below is one field away from selectable. Dropping either status check
// in toReferralCodeOptions therefore changes the expected id list.
const PAYLOAD = {
  agents: [
    {
      status: "ACTIVE",
      displayName: "Thabo M",
      referralCodes: [
        { id: "code-live", code: "ACMABC123", label: "Launch campaign", status: "ACTIVE" },
        { id: "code-retired", code: "ACMOLD999", label: null, status: "RETIRED" },
      ],
    },
    {
      status: "SUSPENDED",
      displayName: "Suspended Sipho",
      referralCodes: [{ id: "code-suspended-agent", code: "ACMSUS111", status: "ACTIVE" }],
    },
  ],
}

describe("toReferralCodeOptions", () => {
  it("keeps only ACTIVE codes belonging to ACTIVE agents", () => {
    expect(toReferralCodeOptions(PAYLOAD).map((o) => o.id)).toEqual(["code-live"])
  })

  it("excludes an ACTIVE code whose agent is not ACTIVE", () => {
    // Same code, only the agent status differs — isolates the agent predicate.
    const ids = toReferralCodeOptions({
      agents: [
        { status: "ACTIVE", displayName: "A", referralCodes: [{ id: "x", code: "C", status: "ACTIVE" }] },
        { status: "ACTIVE", displayName: "B", referralCodes: [{ id: "y", code: "D", status: "ACTIVE" }] },
      ],
    }).map((o) => o.id)
    expect(ids).toEqual(["x", "y"])

    const suspended = toReferralCodeOptions({
      agents: [
        { status: "ACTIVE", displayName: "A", referralCodes: [{ id: "x", code: "C", status: "ACTIVE" }] },
        { status: "SUSPENDED", displayName: "B", referralCodes: [{ id: "y", code: "D", status: "ACTIVE" }] },
      ],
    }).map((o) => o.id)
    expect(suspended).toEqual(["x"])
  })

  it("labels an option with the agent name, code and campaign", () => {
    expect(toReferralCodeOptions(PAYLOAD)[0].label).toBe("Thabo M — ACMABC123 · Launch campaign")
  })

  it("omits the campaign separator when there is no label", () => {
    const [option] = toReferralCodeOptions({
      agents: [
        { status: "ACTIVE", displayName: "Solo", referralCodes: [{ id: "s", code: "ACM111", status: "ACTIVE" }] },
      ],
    })
    expect(option.label).toBe("Solo — ACM111")
  })

  it("sorts alphabetically so the picker order is stable across reloads", () => {
    const labels = toReferralCodeOptions({
      agents: [
        { status: "ACTIVE", displayName: "Zanele", referralCodes: [{ id: "z", code: "ACMZZZ", status: "ACTIVE" }] },
        { status: "ACTIVE", displayName: "Andile", referralCodes: [{ id: "a", code: "ACMAAA", status: "ACTIVE" }] },
      ],
    }).map((o) => o.label)
    expect(labels).toEqual(["Andile — ACMAAA", "Zanele — ACMZZZ"])
  })

  it("survives a malformed or empty payload without throwing", () => {
    expect(toReferralCodeOptions(null)).toEqual([])
    expect(toReferralCodeOptions({})).toEqual([])
    expect(toReferralCodeOptions({ agents: null })).toEqual([])
    // An agent whose code carries no usable id must not become a blank option.
    expect(
      toReferralCodeOptions({
        agents: [{ status: "ACTIVE", displayName: "X", referralCodes: [{ id: null, status: "ACTIVE" }] }],
      }),
    ).toEqual([])
  })
})
