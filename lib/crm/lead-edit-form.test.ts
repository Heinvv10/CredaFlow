import { describe, it, expect } from "vitest"
import { buildLeadPatch, isLeadFormDirty, leadToFormState, type LeadFormState } from "./lead-edit-form"

const convertedLead = {
  firstName: "Thabo",
  lastName: "Molefe",
  email: "thabo@example.co.za",
  phone: "0821112222",
  status: "CONVERTED",
  assignedToId: "user-gone",
  requestedAmount: 55000,
  notes: "Existing note",
}

function state(overrides: Partial<LeadFormState> = {}): LeadFormState {
  return { ...leadToFormState(convertedLead), ...overrides }
}

describe("leadToFormState", () => {
  it("converts cents to whole-rand text and nulls to empty strings", () => {
    const s = leadToFormState({ ...convertedLead, email: null, assignedToId: null, requestedAmount: 123456, notes: null })
    expect(s.requestedRand).toBe("1235")
    expect(s.email).toBe("")
    expect(s.assignedToId).toBe("")
    expect(s.notes).toBe("")
  })
})

describe("buildLeadPatch — dirty fields only", () => {
  it("returns an empty payload when nothing changed, even for a CONVERTED lead", () => {
    const patch = buildLeadPatch(state(), state())
    expect(patch).toEqual({ ok: true, payload: {} })
  })

  it("a notes-only edit on a LOST lead sends ONLY notes — no status, no assignedToId", () => {
    const initial = state({ status: "LOST" })
    const patch = buildLeadPatch(initial, { ...initial, notes: "Called back" })
    expect(patch).toEqual({ ok: true, payload: { notes: "Called back" } })
  })

  it("never resends an untouched stale owner id when other fields change", () => {
    const patch = buildLeadPatch(state(), state({ phone: "0839998888" }))
    expect(patch).toEqual({ ok: true, payload: { phone: "0839998888" } })
  })

  it("sends assignedToId when the owner actually changes, including unassign as empty string", () => {
    expect(buildLeadPatch(state(), state({ assignedToId: "user-2" }))).toEqual({
      ok: true,
      payload: { assignedToId: "user-2" },
    })
    expect(buildLeadPatch(state(), state({ assignedToId: "" }))).toEqual({
      ok: true,
      payload: { assignedToId: "" },
    })
  })

  it("sends a changed stage when it is a plain pipeline stage", () => {
    const initial = state({ status: "NEW" })
    expect(buildLeadPatch(initial, { ...initial, status: "CONTACTED" })).toEqual({
      ok: true,
      payload: { status: "CONTACTED" },
    })
  })

  it("refuses CONVERTED and LOST as form-set stages", () => {
    const initial = state({ status: "NEW" })
    expect(buildLeadPatch(initial, { ...initial, status: "CONVERTED" }).ok).toBe(false)
    expect(buildLeadPatch(initial, { ...initial, status: "LOST" }).ok).toBe(false)
  })
})

describe("buildLeadPatch — value normalisation", () => {
  it("converts rand text to cents", () => {
    const patch = buildLeadPatch(state(), state({ requestedRand: "775" }))
    expect(patch).toEqual({ ok: true, payload: { requestedAmount: 77500 } })
  })

  it("clears requestedAmount with null when the field is emptied", () => {
    const patch = buildLeadPatch(state(), state({ requestedRand: "" }))
    expect(patch).toEqual({ ok: true, payload: { requestedAmount: null } })
  })

  it("maps emptied email and notes to null, and trims a kept email", () => {
    expect(buildLeadPatch(state(), state({ email: "" }))).toEqual({ ok: true, payload: { email: null } })
    expect(buildLeadPatch(state(), state({ email: " new@x.co.za " }))).toEqual({
      ok: true,
      payload: { email: "new@x.co.za" },
    })
    expect(buildLeadPatch(state(), state({ notes: "  " }))).toEqual({ ok: true, payload: { notes: null } })
  })
})

describe("buildLeadPatch — rejections", () => {
  it.each([
    ["firstName", { firstName: "  " }, "First name cannot be empty."],
    ["lastName", { lastName: "" }, "Last name cannot be empty."],
    ["phone", { phone: " " }, "Phone cannot be empty."],
    ["non-numeric amount", { requestedRand: "abc" }, "Requested amount must be a number."],
    ["negative amount", { requestedRand: "-100" }, "Requested amount cannot be negative."],
  ])("rejects %s", (_label, override, error) => {
    expect(buildLeadPatch(state(), state(override))).toEqual({ ok: false, error })
  })
})

describe("isLeadFormDirty", () => {
  it("is false for identical states and true when any single field differs", () => {
    expect(isLeadFormDirty(state(), state())).toBe(false)
    expect(isLeadFormDirty(state(), state({ notes: "x" }))).toBe(true)
    expect(isLeadFormDirty(state(), state({ assignedToId: "" }))).toBe(true)
  })
})
