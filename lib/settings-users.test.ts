import { describe, it, expect, vi, afterEach } from "vitest"
import { assignableRoles, canResetTotp, canWriteUser, loadUsers, resetTotpConfirm } from "./settings-users"

describe("loadUsers", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves with parsed data on a 200 response", async () => {
    const body = {
      users: [{ id: "u1", name: "Alice", email: "a@a.com", role: "LOAN_ADMIN", active: true, createdAt: "2026-01-01" }],
      branches: [{ id: "b1", name: "HQ" }],
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
    await expect(loadUsers()).resolves.toEqual(body)
  })

  it("rejects on a non-OK response instead of returning the error body as data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })))
    await expect(loadUsers()).rejects.toThrow("Failed to load users")
  })

  it("rejects when the network request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    await expect(loadUsers()).rejects.toThrow()
  })
})

describe("assignableRoles", () => {
  // Highest first, the order the Users form lists them in.
  const roles = ["SUPER_ADMIN", "ADMIN", "LOAN_ADMIN", "BRANCH_MANAGER", "CREDIT_OFFICER", "READONLY"].map(value => ({ value }))
  const offered = (callerRole: string) => assignableRoles(roles, callerRole).map(r => r.value)

  it("offers a caller their own role and every role below it, never one above", () => {
    expect(offered("SUPER_ADMIN")).toEqual(["SUPER_ADMIN", "ADMIN", "LOAN_ADMIN", "BRANCH_MANAGER", "CREDIT_OFFICER", "READONLY"])
    expect(offered("ADMIN")).toEqual(["ADMIN", "LOAN_ADMIN", "BRANCH_MANAGER", "CREDIT_OFFICER", "READONLY"])
    expect(offered("BRANCH_MANAGER")).toEqual(["LOAN_ADMIN", "BRANCH_MANAGER", "CREDIT_OFFICER", "READONLY"])
  })

  it("offers nothing to a role the hierarchy does not rank", () => {
    expect(offered("CLIENT")).toEqual([])
  })
})

// Mirrors staffUserWriteRefusal (lib/auth-guards.ts): a caller writes a user who
// ranks below them, or their own row; a peer or a senior is refused.
describe("canWriteUser", () => {
  it("allows a lower-ranked user, refuses a peer and a senior", () => {
    expect(canWriteUser("ADMIN", "CREDIT_OFFICER", false)).toBe(true)
    expect(canWriteUser("ADMIN", "ADMIN", false)).toBe(false)
    expect(canWriteUser("ADMIN", "SUPER_ADMIN", false)).toBe(false)
    expect(canWriteUser("SUPER_ADMIN", "SUPER_ADMIN", false)).toBe(false)
  })

  it("allows the caller's own row, and refuses an unknown role", () => {
    expect(canWriteUser("ADMIN", "ADMIN", true)).toBe(true)
    expect(canWriteUser("FUTURE_ROLE", "READONLY", false)).toBe(false)
    expect(canWriteUser("ADMIN", "FUTURE_ROLE", false)).toBe(false)
  })
})

describe("canResetTotp", () => {
  const ok = { callerRole: "ADMIN", callerTotpVerified: true, targetRole: "CREDIT_OFFICER", targetEnrolled: true, isSelf: false }

  it("is offered to an ADMIN or above, in a TOTP-verified session, for a lower-ranked user with 2FA enrolled", () => {
    expect(canResetTotp(ok)).toBe(true)
    expect(canResetTotp({ ...ok, callerRole: "SUPER_ADMIN", targetRole: "ADMIN" })).toBe(true)
  })

  it.each([
    ["the session did not verify TOTP", { callerTotpVerified: false }],
    ["the caller is below ADMIN", { callerRole: "BRANCH_MANAGER", targetRole: "READONLY" }],
    ["the user is a peer", { targetRole: "ADMIN" }],
    ["the user outranks the caller", { targetRole: "SUPER_ADMIN" }],
    ["the user has no 2FA enrolled", { targetEnrolled: false }],
    ["enrolment is unknown", { targetEnrolled: undefined }],
    ["the user is the caller", { isSelf: true }],
  ])("is not offered when %s", (_label, change) => {
    expect(canResetTotp({ ...ok, ...change })).toBe(false)
  })
})

describe("resetTotpConfirm", () => {
  it("promises re-enrolment while the lender requires 2FA", () => {
    expect(resetTotpConfirm("Sam Dlamini", true)).toBe(
      "Reset two-factor authentication for Sam Dlamini? They will be signed out and must set it up again at their next sign-in.",
    )
  })

  it("does not promise it while the setting is off", () => {
    expect(resetTotpConfirm("Sam Dlamini", false)).toBe(
      "Reset two-factor authentication for Sam Dlamini? They will be signed out. Two-factor authentication will be off until they set it up again.",
    )
  })
})
