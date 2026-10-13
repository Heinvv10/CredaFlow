import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SettingsUser } from "@/lib/settings-users"

const loadUsersMock = vi.fn()
vi.mock("@/lib/settings-users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-users")>()),
  loadUsers: () => loadUsersMock(),
}))
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { UserTable } from "./UserTable"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const staff = (id: string, role: string, totpEnabled = false): SettingsUser =>
  ({ id, name: `Staff ${id}`, email: `${id}@acme-lending.example`, role, active: true, createdAt: "2026-01-01", totpEnabled })

/** The action buttons' titles on the row for `email`. */
function actions(renderer: ReactTestRenderer, email: string): string[] {
  const hasText = (node: ReactTestInstance): boolean =>
    node.children.some(c => (typeof c === "string" ? c === email : hasText(c)))
  const row = renderer.root.findAll(n => n.type === "tr" && hasText(n))
  expect(row).toHaveLength(1)
  return row[0]!.findAll(n => n.type === "button").map(b => String(b.props.title))
}

async function render(callerRole: string, totpVerified = true) {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<UserTable currentUserId="me" currentUserRole={callerRole} currentUserTotpVerified={totpVerified} />)
  })
  return renderer
}

// The server refuses any write to a user who outranks the caller
// (staffUserWriteRefusal); the table does not offer one.
describe("UserTable row actions", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    loadUsersMock.mockResolvedValue({
      users: [staff("root", "SUPER_ADMIN"), staff("peer", "ADMIN"), staff("officer", "CREDIT_OFFICER"), staff("me", "ADMIN")],
      branches: [],
    })
  })

  afterEach(() => {
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("offers only View details on a user who outranks the caller", async () => {
    const renderer = await render("ADMIN")
    expect(actions(renderer, "root@acme-lending.example")).toEqual(["View details"])
  })

  // The server refuses a write to a user level with the caller (their own row
  // excepted): a peer gets no edit, password reset or deactivation either.
  it("offers edit, password reset and deactivation on lower-ranked users only", async () => {
    const renderer = await render("ADMIN")
    expect(actions(renderer, "officer@acme-lending.example")).toEqual(["View details", "Edit user", "Reset password", "Deactivate"])
    expect(actions(renderer, "peer@acme-lending.example")).toEqual(["View details"])
  })

  it("offers the caller their own row's edit and password reset, but not deactivation", async () => {
    const renderer = await render("ADMIN")
    expect(actions(renderer, "me@acme-lending.example")).toEqual(["View details", "Edit user", "Reset password"])
  })

  it("offers a SUPER_ADMIN every action, delete included, on a lower-ranked user, and nothing but details on another SUPER_ADMIN", async () => {
    const renderer = await render("SUPER_ADMIN")
    expect(actions(renderer, "peer@acme-lending.example")).toEqual(["View details", "Edit user", "Reset password", "Deactivate", "Delete user"])
    expect(actions(renderer, "root@acme-lending.example")).toEqual(["View details"])
  })
})

// DELETE /api/settings/users/[id]/totp: ADMIN or above, TOTP-verified session,
// strictly outranking the target, who has 2FA enrolled.
describe("UserTable Reset 2FA button", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    loadUsersMock.mockResolvedValue({
      users: [staff("peer", "ADMIN", true), staff("enrolled", "CREDIT_OFFICER", true), staff("plain", "CREDIT_OFFICER", false), staff("me", "ADMIN", true)],
      branches: [],
    })
  })

  afterEach(() => {
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("is offered for a lower-ranked user with 2FA enrolled", async () => {
    const renderer = await render("ADMIN")
    expect(actions(renderer, "enrolled@acme-lending.example")).toContain("Reset 2FA")
  })

  it.each([
    ["has no 2FA enrolled", "plain@acme-lending.example", "ADMIN", true],
    ["is level with the caller", "peer@acme-lending.example", "ADMIN", true],
    ["is the caller", "me@acme-lending.example", "ADMIN", true],
    ["is reached in a session that did not verify TOTP", "enrolled@acme-lending.example", "ADMIN", false],
    ["is reached by a caller below ADMIN", "enrolled@acme-lending.example", "BRANCH_MANAGER", true],
  ])("is not offered for a user who %s", async (_label, email, callerRole, totpVerified) => {
    const renderer = await render(callerRole, totpVerified)
    expect(actions(renderer, email)).not.toContain("Reset 2FA")
  })
})
