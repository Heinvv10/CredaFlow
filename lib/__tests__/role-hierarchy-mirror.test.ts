import { describe, expect, it, vi } from "vitest"
import { UserRole } from "@prisma/client"

// Mock Next.js modules that next-auth pulls in at import time.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))

import { ROLE_HIERARCHY as SERVER_HIERARCHY } from "../auth-guards"
import { ROLE_HIERARCHY as CLIENT_HIERARCHY } from "../permissions"
import { OPERATOR_ROLES, isOperatorRole } from "../operator/roles"

// The server enforces the role ceiling with lib/auth-guards.ts; the Users form
// and nav decide what to offer with the client-safe copy in lib/permissions.ts.
// If the two drift, the UI offers what the server refuses, or hides what it allows.
describe("ROLE_HIERARCHY", () => {
  it("is the same list, in the same order, on the server and the client", () => {
    expect(CLIENT_HIERARCHY).toEqual(SERVER_HIERARCHY)
  })

  // A role missing from the hierarchy ranks nowhere: its holders clear no gate
  // and can be assigned by nobody.
  it("ranks every tenant role in the database enum, each once", () => {
    const tenantRoles = Object.values(UserRole).filter((r) => !isOperatorRole(r))
    expect([...SERVER_HIERARCHY].sort()).toEqual(tenantRoles.sort())
  })

  // Operator staff are outside the hierarchy on purpose: ranked nowhere, they
  // clear no tenant gate (lib/operator/roles.ts).
  it("ranks no operator role", () => {
    expect(OPERATOR_ROLES.length).toBeGreaterThan(0)
    for (const role of OPERATOR_ROLES) {
      expect(Object.values(UserRole)).toContain(role)
      expect(SERVER_HIERARCHY).not.toContain(role)
      expect(CLIENT_HIERARCHY).not.toContain(role)
    }
  })
})
