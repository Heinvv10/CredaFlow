import { describe, expect, it, vi } from "vitest"

// Only for the parity half: lib/auth-guards.ts loads NextAuth. comms-agent.ts itself does not.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))

import { UserRole } from "@prisma/client"
import type { AppRole } from "@/lib/auth-guards"
import { hasMinRole as guardHasMinRole } from "@/lib/auth-guards"
import { hasMinRole, type UserRole as PermRole } from "@/lib/permissions"
import { isCommsAgentAllowed } from "./comms-agent"

const ROLES = Object.values(UserRole)

describe("isCommsAgentAllowed", () => {
  it.each([
    ["READONLY", true, true],
    ["READONLY", false, false],
    ["BRANCH_MANAGER", false, false],
    ["ADMIN", false, true],
    ["SUPER_ADMIN", false, true],
    ["CLIENT", true, false],
    ["NOT_A_ROLE", true, false],
  ])("%s, flagged %s -> %s", (role, flagged, allowed) => {
    expect(isCommsAgentAllowed(role, flagged)).toBe(allowed)
  })
})

// comms-agent.ts gates on lib/permissions.ts; the session guards gate on lib/auth-guards.ts.
// The two role hierarchies are separate copies, so this pins them to the same answers.
describe("hasMinRole parity: lib/permissions.ts vs lib/auth-guards.ts", () => {
  it("covers every role in the schema", () => {
    // Nine tenant roles plus the two operator roles (lib/operator/roles.ts).
    expect(ROLES).toHaveLength(11)
  })

  it.each([...ROLES, "CLIENT", "NOT_A_ROLE"])("%s agrees for every minimum role", (role) => {
    for (const min of ROLES) {
      expect([min, hasMinRole(role as PermRole, min)]).toEqual([min, guardHasMinRole(role as AppRole, min)])
    }
  })

  it("is not vacuous: both rank ADMIN above READONLY and deny the reverse", () => {
    expect([hasMinRole("ADMIN", "READONLY"), guardHasMinRole("ADMIN", "READONLY")]).toEqual([true, true])
    expect([hasMinRole("READONLY", "ADMIN"), guardHasMinRole("READONLY", "ADMIN")]).toEqual([false, false])
  })
})
