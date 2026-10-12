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

const staff = (id: string, role: string): SettingsUser =>
  ({ id, name: `Staff ${id}`, email: `${id}@acme-lending.example`, role, active: true, createdAt: "2026-01-01" })

/** The action buttons' titles on the row for `email`. */
function actions(renderer: ReactTestRenderer, email: string): string[] {
  const hasText = (node: ReactTestInstance): boolean =>
    node.children.some(c => (typeof c === "string" ? c === email : hasText(c)))
  const row = renderer.root.findAll(n => n.type === "tr" && hasText(n))
  expect(row).toHaveLength(1)
  return row[0]!.findAll(n => n.type === "button").map(b => String(b.props.title))
}

async function render(callerRole: string) {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<UserTable currentUserId="me" currentUserRole={callerRole} />)
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

  it("offers edit, password reset and deactivation on equal and lower-ranked users", async () => {
    const renderer = await render("ADMIN")
    for (const email of ["peer@acme-lending.example", "officer@acme-lending.example"]) {
      expect(actions(renderer, email)).toEqual(["View details", "Edit user", "Reset password", "Deactivate"])
    }
  })

  it("offers a SUPER_ADMIN every action, delete included, on everyone but themself", async () => {
    const renderer = await render("SUPER_ADMIN")
    expect(actions(renderer, "root@acme-lending.example")).toEqual(["View details", "Edit user", "Reset password", "Deactivate", "Delete user"])
    expect(actions(renderer, "me@acme-lending.example")).toEqual(["View details", "Edit user", "Reset password"])
  })
})
