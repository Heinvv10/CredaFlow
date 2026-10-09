/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findMany: vi.fn(), findFirst: vi.fn() } },
}))

import { listAssignableStaff, findAssignableStaff, isAssignableStaff } from "./staff"
import { prisma } from "@/lib/prisma"

beforeEach(() => vi.clearAllMocks())

// `User` is NOT in TENANT_SCOPED_MODELS (lib/tenant-scope.ts), so nothing
// auto-injects the tenant filter — dropping it here silently offers every
// tenant's staff as an assignee. Pin the whole query shape: asserting only on
// the returned rows would pass against an unscoped findMany, since the mock
// returns whatever it is told to regardless of the `where`.
it("scopes the staff query to the tenant's own active users", async () => {
  vi.mocked(prisma.user.findMany).mockResolvedValue([
    { id: "u1", name: "Thandi Nkosi", email: "thandi@acme-lending.example" },
  ] as any)

  const staff = await listAssignableStaff("t1")

  expect(staff).toEqual([{ id: "u1", name: "Thandi Nkosi", email: "thandi@acme-lending.example" }])
  expect(prisma.user.findMany).toHaveBeenCalledWith({
    where: { tenantId: "t1", active: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  })
})

it("never selects fields the picker does not need", async () => {
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as any)

  await listAssignableStaff("t1")

  // The result is serialised into the lead detail RSC payload, so the select
  // is the exposure boundary — role/phone/totpSecret must not ride along.
  const select = vi.mocked(prisma.user.findMany).mock.calls[0][0]?.select
  expect(Object.keys(select ?? {}).sort()).toEqual(["email", "id", "name"])
})

it("findAssignableStaff scopes the single-owner lookup to tenant + active", async () => {
  vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "u1", name: "T", email: "t@n.co" } as any)

  await findAssignableStaff("t1", "u1")

  expect(prisma.user.findFirst).toHaveBeenCalledWith({
    where: { id: "u1", tenantId: "t1", active: true },
    select: { id: true, name: true, email: true },
  })
})

// The single rule every write path shares. If this filter loses tenantId or
// active, all three paths (reassign action + both /api/crm/leads routes) start
// accepting assignees they must reject.
describe("isAssignableStaff", () => {
  it("accepts a match and queries scoped to tenant + active", async () => {
    const users = { findFirst: vi.fn().mockResolvedValue({ id: "u2" }) }

    await expect(isAssignableStaff(users, { tenantId: "t1", userId: "u2" })).resolves.toBe(true)
    expect(users.findFirst).toHaveBeenCalledWith({
      where: { id: "u2", tenantId: "t1", active: true },
      select: { id: true },
    })
  })

  it("rejects when no active user in this tenant matches", async () => {
    const users = { findFirst: vi.fn().mockResolvedValue(null) }
    await expect(isAssignableStaff(users, { tenantId: "t1", userId: "ghost" })).resolves.toBe(false)
  })
})
