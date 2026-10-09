/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { conversation: { updateMany: vi.fn(), findFirst: vi.fn() } },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { claimConversation, releaseConversation, reassignConversation } from "./assignment"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"

beforeEach(() => vi.clearAllMocks())

describe("claimConversation", () => {
  it("claims an unassigned thread atomically and audits", async () => {
    vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 1 } as any)
    const r = await claimConversation({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1", agentEmail: "a@b.c" })
    expect(r).toEqual({ ok: true })
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "cv1", tenantId: "t1", assigneeId: null, status: { not: "CLOSED" } },
      data: { assigneeId: "u1" },
    })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CONVERSATION_CLAIMED", entity: "Conversation", entityId: "cv1", userId: "u1" }))
  })

  it("returns ALREADY_CLAIMED when nothing was updated (no audit)", async () => {
    vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 0 } as any)
    const r = await claimConversation({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1" })
    expect(r).toEqual({ ok: false, reason: "ALREADY_CLAIMED" })
    expect(logAudit).not.toHaveBeenCalled()
  })
})

describe("releaseConversation", () => {
  it("releases only a thread the caller owns", async () => {
    vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 1 } as any)
    const r = await releaseConversation({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1" })
    expect(r).toEqual({ ok: true })
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "cv1", tenantId: "t1", assigneeId: "u1" },
      data: { assigneeId: null },
    })
  })
  it("returns NOT_ASSIGNED_TO_YOU when the caller is not the owner", async () => {
    vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 0 } as any)
    const r = await releaseConversation({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1" })
    expect(r).toEqual({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
  })
})

describe("reassignConversation", () => {
  it("sets a new owner and audits old→new", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ assigneeId: "u1" } as any)
    vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 1 } as any)
    const r = await reassignConversation({ tenantId: "t1", conversationId: "cv1", newAssigneeId: "u2", actorUserId: "admin1" })
    expect(r).toEqual({ ok: true })
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "cv1", tenantId: "t1" },
      data: { assigneeId: "u2" },
    })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "CONVERSATION_REASSIGNED", entityId: "cv1",
      oldValue: { assigneeId: "u1" }, newValue: { assigneeId: "u2" },
    }))
  })
  it("returns NOT_FOUND when the conversation is absent", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
    vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 0 } as any)
    const r = await reassignConversation({ tenantId: "t1", conversationId: "cvX", newAssigneeId: "u2", actorUserId: "admin1" })
    expect(r).toEqual({ ok: false, reason: "NOT_FOUND" })
  })
})
