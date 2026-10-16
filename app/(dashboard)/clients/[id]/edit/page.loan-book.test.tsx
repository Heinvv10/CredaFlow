import { describe, expect, it, vi } from "vitest"

// #145 breaker review (HIGH): the client edit form sent the affordability
// evidence (income, expenses, breakdown, declared debt) to an
// INSURANCE_OFFICER's browser. The page now refuses a role without the loan
// book before reading anything.
const { session, findUnique, redirect } = vi.hoisted(() => ({
  session: { role: "INSURANCE_OFFICER" },
  findUnique: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`) }),
}))
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND") }, redirect }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1", role: session.role, tenantId: "t1" } })) }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findUnique } } }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: async () => "t1" }))
vi.mock("@/components/clients/ClientFormLegacy", () => ({ ClientForm: () => null }))
vi.mock("@/components/layout/Header", () => ({ Header: () => null }))

import EditClientPage from "./page"

describe("client edit page", () => {
  it("sends INSURANCE_OFFICER to the no-access page and reads no client", async () => {
    await expect(EditClientPage({ params: Promise.resolve({ id: "c1" }) })).rejects.toThrow("REDIRECT /no-access")
    expect(findUnique).not.toHaveBeenCalled()
  })

  it("opens for a role that reads the loan book", async () => {
    session.role = "READONLY"
    findUnique.mockResolvedValue(null)
    // Past the gate: it reads the client (none here, so not found).
    await expect(EditClientPage({ params: Promise.resolve({ id: "c1" }) })).rejects.toThrow("NOT_FOUND")
    expect(findUnique).toHaveBeenCalled()
  })
})
