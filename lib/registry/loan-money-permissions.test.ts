import { describe, expect, it, vi } from "vitest"

// lib/auth-guards imports the NextAuth config, which cannot load under vitest.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
import { canDo as serverCanDo, hasMinRole, ROLE_HIERARCHY, type PermissionKey } from "@/lib/auth-guards"
import { canDo as clientCanDo } from "@/lib/permissions"

// The ladder gate each route used before the permission existed. Every role
// keeps exactly that access except INSURANCE_OFFICER, which loses it: the
// Fair Score audit (2026-10-16) recorded a payment as an insurance officer.
const PREVIOUS_GATE: Record<string, (typeof ROLE_HIERARCHY)[number]> = {
  capture_payment: "COLLECTIONS_AGENT", // POST /api/payments
  amend_application: "LOAN_ADMIN", // POST /api/applications/[id]/decide (return_to_draft)
  edit_application: "CREDIT_OFFICER", // PATCH /api/applications/[id]
  cancel_application: "CREDIT_OFFICER", // DELETE /api/applications/[id]
  edit_affordability: "CREDIT_OFFICER", // PATCH /api/applications/[id]/affordability
}

describe.each(Object.entries(PREVIOUS_GATE))("%s", (permission, previous) => {
  it("is refused to INSURANCE_OFFICER on the server and in the UI", () => {
    expect(serverCanDo("INSURANCE_OFFICER", permission as PermissionKey)).toBe(false)
    expect(clientCanDo("INSURANCE_OFFICER", permission)).toBe(false)
  })

  it("widens no role, and narrows none but INSURANCE_OFFICER", () => {
    for (const role of ROLE_HIERARCHY) {
      const expected = role !== "INSURANCE_OFFICER" && hasMinRole(role, previous)
      expect([role, serverCanDo(role, permission as PermissionKey)]).toEqual([role, expected])
      expect([role, clientCanDo(role, permission)]).toEqual([role, expected])
    }
  })

  it("is refused to a client and to operator staff", () => {
    expect(serverCanDo("CLIENT", permission as PermissionKey)).toBe(false)
    expect(clientCanDo("OPERATOR_ADMIN", permission)).toBe(false)
  })
})
