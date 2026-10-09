/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findMany: vi.fn(), updateMany: vi.fn() } },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { listStaffForRoster, listActiveCommsAgents, setCommsAgent } from "./roster"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"

beforeEach(() => vi.clearAllMocks())

it("lists active tenant staff, ordered by name", async () => {
  vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: "u1", name: "A", email: "a@b.c", role: "CREDIT_OFFICER", isCommsAgent: false }] as any)
  const r = await listStaffForRoster("t1")
  expect(r).toHaveLength(1)
  expect(prisma.user.findMany).toHaveBeenCalledWith({
    where: { tenantId: "t1", active: true },
    select: { id: true, name: true, email: true, role: true, isCommsAgent: true },
    orderBy: { name: "asc" },
  })
})

it("lists only active comms agents", async () => {
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as any)
  await listActiveCommsAgents("t1")
  expect(prisma.user.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { tenantId: "t1", active: true, isCommsAgent: true } }),
  )
})

it("toggles the flag tenant-scoped and audits", async () => {
  vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as any)
  const r = await setCommsAgent({ tenantId: "t1", userId: "u1", isCommsAgent: true, actorUserId: "admin1" })
  expect(r).toEqual({ ok: true })
  expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: "u1", tenantId: "t1" }, data: { isCommsAgent: true } })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_UPDATED", entity: "User", entityId: "u1", newValue: { isCommsAgent: true } }))
})

it("returns ok:false when the user is not in the tenant", async () => {
  vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as any)
  const r = await setCommsAgent({ tenantId: "t1", userId: "uX", isCommsAgent: true, actorUserId: "admin1" })
  expect(r).toEqual({ ok: false })
  expect(logAudit).not.toHaveBeenCalled()
})
