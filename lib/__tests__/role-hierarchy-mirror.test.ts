import { describe, expect, it, vi } from "vitest"
import { UserRole } from "@prisma/client"

// Mock Next.js modules that next-auth pulls in at import time.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))

import { ROLE_HIERARCHY as SERVER_HIERARCHY } from "../auth-guards"
import { ROLE_HIERARCHY as CLIENT_HIERARCHY } from "../permissions"

// The server enforces the role ceiling with lib/auth-guards.ts; the Users form
// and nav decide what to offer with the client-safe copy in lib/permissions.ts.
// If the two drift, the UI offers what the server refuses, or hides what it allows.
describe("ROLE_HIERARCHY", () => {
  it("is the same list, in the same order, on the server and the client", () => {
    expect(CLIENT_HIERARCHY).toEqual(SERVER_HIERARCHY)
  })

  // A role missing from the hierarchy ranks nowhere: its holders clear no gate
  // and can be assigned by nobody.
  it("ranks every role in the database enum, each once", () => {
    expect([...SERVER_HIERARCHY].sort()).toEqual(Object.values(UserRole).sort())
  })
})
