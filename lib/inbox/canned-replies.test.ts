/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { cannedReply: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() } },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { listCannedReplies, createCannedReply, updateCannedReply, deleteCannedReply } from "./canned-replies"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"

beforeEach(() => vi.clearAllMocks())

it("lists tenant canned replies ordered by title", async () => {
  vi.mocked(prisma.cannedReply.findMany).mockResolvedValue([{ id: "cr1" }] as any)
  const r = await listCannedReplies("t1")
  expect(r).toHaveLength(1)
  expect(prisma.cannedReply.findMany).toHaveBeenCalledWith({ where: { tenantId: "t1" }, orderBy: { title: "asc" } })
})

it("creates + audits", async () => {
  vi.mocked(prisma.cannedReply.create).mockResolvedValue({ id: "cr9" } as any)
  const r = await createCannedReply({ tenantId: "t1", title: "Greeting", body: "Hi!", createdById: "u1" })
  expect(r.id).toBe("cr9")
  expect(prisma.cannedReply.create).toHaveBeenCalledWith({ data: { tenantId: "t1", title: "Greeting", body: "Hi!", createdById: "u1" } })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CANNED_REPLY_CREATED", entity: "CannedReply", entityId: "cr9" }))
})

it("update is tenant-scoped and returns ok:false when nothing matched", async () => {
  vi.mocked(prisma.cannedReply.updateMany).mockResolvedValue({ count: 0 } as any)
  const r = await updateCannedReply({ tenantId: "t1", id: "crX", title: "x", actorUserId: "u1" })
  expect(r).toEqual({ ok: false })
  expect(prisma.cannedReply.updateMany).toHaveBeenCalledWith({ where: { id: "crX", tenantId: "t1" }, data: { title: "x" } })
  expect(logAudit).not.toHaveBeenCalled()
})

it("delete is tenant-scoped + audited on success", async () => {
  vi.mocked(prisma.cannedReply.deleteMany).mockResolvedValue({ count: 1 } as any)
  const r = await deleteCannedReply({ tenantId: "t1", id: "cr1", actorUserId: "u1" })
  expect(r).toEqual({ ok: true })
  expect(prisma.cannedReply.deleteMany).toHaveBeenCalledWith({ where: { id: "cr1", tenantId: "t1" } })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CANNED_REPLY_DELETED", entityId: "cr1" }))
})
