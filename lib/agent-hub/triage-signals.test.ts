import { describe, it, expect } from "vitest"
import { normalisePhone, detectSignals } from "./triage-signals"
import { REASONS } from "./decision-reasons"

const agents = [
  { id: "a1", displayName: "Agent One", phone: "0821112222" },
  { id: "a2", displayName: "Agent Two", phone: "082 000 0727" },
  { id: "a3", displayName: "No Phone Agent", phone: null },
]

const base = { borrowerClientId: "c1", borrowerPhone: null, referringAgentId: "a1", agents, repeatPairs: [] }

describe("normalisePhone", () => {
  // SA numbers arrive as 0820000727, +27820000727, and with spaces. The last
  // 9 digits are the stable part across all three forms.
  it("reduces every local format to the same 9 digits", () => {
    expect(normalisePhone("0820000727")).toBe("820000727")
    expect(normalisePhone("+27820000727")).toBe("820000727")
    expect(normalisePhone("082 000 0727")).toBe("820000727")
  })

  it("returns null for absent or too-short input", () => {
    expect(normalisePhone(null)).toBeNull()
    expect(normalisePhone("")).toBeNull()
    expect(normalisePhone("12345")).toBeNull()
  })

  // Boundary on PHONE_KEY_LENGTH itself. Exactly 9 digits IS the key, so it
  // must survive; without this a `<` → `<=` flip in the length guard passes
  // every test while silently rejecting every already-normalised number.
  it("accepts a number that is exactly the 9-digit key", () => {
    expect(normalisePhone("820000727")).toBe("820000727")
    expect(normalisePhone("82000072")).toBeNull()
  })
})

describe("detectSignals", () => {
  it("fires when the borrower shares a phone with any agent", () => {
    const out = detectSignals({ ...base, borrowerPhone: "+27820000727" })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe("AGENT_SHARES_PHONE")
    expect(out[0].message).toContain("Agent Two")
    // Pins the CONSUMER's reach into REASONS, not just the indices (see the
    // "REASONS indices" block below) — a mis-reach here (e.g. BLOCKED[1]
    // typo'd to BLOCKED[2]) must fail even though the indices stay correct.
    expect(out[0].blockReason).toBe("Agent not eligible")
    expect(out[0].dismissReason).toBe("Checked — agent relationship is legitimate")
  })

  it("fires on the REFERRING agent too, not just other agents", () => {
    const out = detectSignals({ ...base, borrowerPhone: "0821112222" })
    expect(out.map((s) => s.kind)).toEqual(["AGENT_SHARES_PHONE"])
  })

  it("stays silent when no phone matches", () => {
    expect(detectSignals({ ...base, borrowerPhone: "0839998888" })).toEqual([])
  })

  // A null agent phone must never match a null borrower phone — that would fire
  // on every row with incomplete data.
  it("never matches on missing phones", () => {
    expect(detectSignals({ ...base, borrowerPhone: null })).toEqual([])
    expect(detectSignals({ ...base, borrowerPhone: "", agents: [{ id: "a3", displayName: "No Phone Agent", phone: null }] })).toEqual([])
  })

  it("fires when this agent referred this borrower more than once", () => {
    const out = detectSignals({ ...base, repeatPairs: [{ agentId: "a1", clientId: "c1", count: 2 }] })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe("REPEAT_BORROWER_SAME_AGENT")
    expect(out[0].message).toContain("2")
    expect(out[0].blockReason).toBe("Duplicate referral")
    expect(out[0].dismissReason).toBe("Checked — not a duplicate")
  })

  it("does not fire for a repeat under a DIFFERENT agent", () => {
    expect(detectSignals({ ...base, repeatPairs: [{ agentId: "a2", clientId: "c1", count: 3 }] })).toEqual([])
  })

  // The other half of the join, and the one every other fixture leaves
  // untested: every repeatPairs fixture above uses clientId "c1", which IS
  // base.borrowerClientId, so deleting `pair.clientId === input.borrowerClientId`
  // left the whole suite green. Without that clause any agent with two or more
  // CONVERTED referrals fires "Referred N× by this agent" on EVERY row they
  // touch — routing an innocent first-time borrower into a pre-filled
  // "Duplicate referral" Block.
  it("does not fire for the same agent's repeat with a DIFFERENT borrower", () => {
    expect(detectSignals({ ...base, repeatPairs: [{ agentId: "a1", clientId: "c-other", count: 5 }] })).toEqual([])
  })

  // Boundary: a first-time referral (count: 1) must NOT fire. Without this,
  // a mutant relaxing `count > 1` to `count >= 1` survives — and would turn
  // the signal into noise on every first referral.
  it("does not fire on a first-time referral (count: 1)", () => {
    expect(detectSignals({ ...base, repeatPairs: [{ agentId: "a1", clientId: "c1", count: 1 }] })).toEqual([])
  })

  it("returns high severity before medium", () => {
    const out = detectSignals({ ...base, borrowerPhone: "0821112222", repeatPairs: [{ agentId: "a1", clientId: "c1", count: 2 }] })
    expect(out.map((s) => s.severity)).toEqual(["high", "medium"])
  })

  it("returns nothing when the borrower could not be resolved", () => {
    expect(detectSignals({ ...base, borrowerClientId: null, borrowerPhone: "0821112222", repeatPairs: [{ agentId: "a1", clientId: "c1", count: 2 }] })).toEqual([])
  })
})

// triage-signals.ts reaches into REASONS by index (BLOCKED[1], PAYABLE[1],
// BLOCKED[0], PAYABLE[0]) rather than a named constant. Nothing in the type
// system ties those indices to their strings, so a future reorder of
// decision-reasons.ts's arrays would silently repoint these presets with no
// compiler error. Pin the mapping here so a reorder is a loud test failure
// instead of a silently wrong preset landing in the audit log.
describe("REASONS indices consumed by triage signals", () => {
  it("AGENT_SHARES_PHONE presets resolve to the expected strings", () => {
    expect(REASONS.BLOCKED[1]).toBe("Agent not eligible")
    expect(REASONS.PAYABLE[1]).toBe("Checked — agent relationship is legitimate")
  })

  it("REPEAT_BORROWER_SAME_AGENT presets resolve to the expected strings", () => {
    expect(REASONS.BLOCKED[0]).toBe("Duplicate referral")
    expect(REASONS.PAYABLE[0]).toBe("Checked — not a duplicate")
  })
})
