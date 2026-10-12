import { describe, it, expect, vi, afterEach } from "vitest"
import { assignableRoles, loadUsers } from "./settings-users"

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
