import { describe, it, expect } from "vitest"
import { resolveLeadOwner, type AssignableStaff } from "./lead-assignment"

const STAFF: AssignableStaff[] = [
  { id: "u1", name: "Thandi Nkosi", email: "thandi@acme-lending.example" },
  { id: "u2", name: null, email: "noname@acme-lending.example" },
]

describe("resolveLeadOwner", () => {
  it("reports an unset owner as unassigned", () => {
    expect(resolveLeadOwner(null, STAFF)).toEqual({
      state: "unassigned",
      label: "Unassigned",
      staff: null,
    })
  })

  it("treats an empty-string owner id as unassigned", () => {
    // The picker submits "" for the Unassigned option; a lead written that way
    // must not resolve as a dangling owner.
    expect(resolveLeadOwner("", STAFF).state).toBe("unassigned")
  })

  it("resolves an owner to their name", () => {
    const owner = resolveLeadOwner("u1", STAFF)
    expect(owner.state).toBe("assigned")
    expect(owner.label).toBe("Thandi Nkosi")
    expect(owner.staff).toEqual(STAFF[0])
  })

  it("falls back to email when the owner has no name", () => {
    expect(resolveLeadOwner("u2", STAFF).label).toBe("noname@acme-lending.example")
  })

  it("reports a dangling owner id as unknown, NOT unassigned", () => {
    // Deactivated / deleted / other-tenant user. Collapsing this into
    // "unassigned" would tell an agent the lead is free to take.
    const owner = resolveLeadOwner("ghost", STAFF)
    expect(owner.state).toBe("unknown")
    expect(owner.staff).toBeNull()
  })

  it("reports an owner missing from an empty staff list as unknown", () => {
    expect(resolveLeadOwner("u1", []).state).toBe("unknown")
  })
})
