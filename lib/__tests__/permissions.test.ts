import { describe, it, expect } from "vitest"
import { hasMinRole, type UserRole } from "../permissions"

describe("hasMinRole (client-safe)", () => {
  it("returns true when userRole equals minRole", () => {
    expect(hasMinRole("LOAN_ADMIN", "LOAN_ADMIN")).toBe(true)
  })

  it("returns true when userRole is above minRole in hierarchy", () => {
    expect(hasMinRole("BRANCH_MANAGER", "LOAN_ADMIN")).toBe(true)
    expect(hasMinRole("ADMIN", "LOAN_ADMIN")).toBe(true)
    expect(hasMinRole("SUPER_ADMIN", "LOAN_ADMIN")).toBe(true)
  })

  it("returns false when userRole is below minRole", () => {
    expect(hasMinRole("LOAN_ADMIN", "BRANCH_MANAGER")).toBe(false)
    expect(hasMinRole("READONLY", "CREDIT_OFFICER")).toBe(false)
  })

  // Unknown role must never pass — mirrors the fail-closed guard in
  // lib/auth-guards.ts hasMinRole, now load-bearing for nav-item visibility too.
  it("returns false for an unrecognised role on either side (fail-closed)", () => {
    expect(hasMinRole("UNKNOWN_FUTURE_ROLE" as UserRole, "READONLY")).toBe(false)
    expect(hasMinRole("SUPER_ADMIN", "UNKNOWN_FUTURE_ROLE" as UserRole)).toBe(false)
    expect(hasMinRole("UNKNOWN_FUTURE_ROLE" as UserRole, "UNKNOWN_FUTURE_ROLE" as UserRole)).toBe(false)
  })
})
