/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: { updateMany: vi.fn() },
    conversation: { updateMany: vi.fn(), findFirst: vi.fn() },
  },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { markConversationRead, setConversationStatus, setConversationPriority } from "./thread-actions"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"

const now = new Date("2026-07-05T12:00:00.000Z")
beforeEach(() => vi.clearAllMocks())

it("markConversationRead sets readAt on unread INBOUND only", async () => {
  vi.mocked(prisma.message.updateMany).mockResolvedValue({ count: 2 } as any)
  const r = await markConversationRead({ tenantId: "t1", conversationId: "cv1", now })
  expect(r).toEqual({ marked: 2 })
  expect(prisma.message.updateMany).toHaveBeenCalledWith({
    where: { tenantId: "t1", conversationId: "cv1", direction: "INBOUND", readAt: null },
    data: { readAt: now },
  })
  expect(logAudit).not.toHaveBeenCalled()
})

it("setConversationStatus CLOSED stamps closedAt and audits", async () => {
  vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 1 } as any)
  const r = await setConversationStatus({ tenantId: "t1", conversationId: "cv1", status: "CLOSED", actorUserId: "u1", now })
  expect(r).toEqual({ ok: true })
  expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
    where: { id: "cv1", tenantId: "t1" },
    data: { status: "CLOSED", closedAt: now },
  })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CONVERSATION_STATUS_CHANGED", newValue: { status: "CLOSED" } }))
})

it("setConversationStatus OPEN clears closedAt", async () => {
  // Target is already open, so no sibling check can apply.
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ contactId: "ct1", closedAt: null } as any)
  vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 1 } as any)
  const r = await setConversationStatus({ tenantId: "t1", conversationId: "cv1", status: "OPEN", actorUserId: "u1", now })
  expect(r).toEqual({ ok: true })
  expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
    where: { id: "cv1", tenantId: "t1" },
    data: { status: "OPEN", closedAt: null },
  })
})

it("setConversationStatus refuses to reopen when the contact already has an open thread", async () => {
  vi.mocked(prisma.conversation.findFirst)
    // 1st call: the target thread — closed, so a sibling check is required.
    .mockResolvedValueOnce({ contactId: "ct1", closedAt: new Date("2026-07-01T00:00:00.000Z") } as any)
    // 2nd call: the sibling that already holds the one-open slot.
    .mockResolvedValueOnce({ id: "cv-open" } as any)

  const r = await setConversationStatus({ tenantId: "t1", conversationId: "cv1", status: "OPEN", actorUserId: "u1", now })

  expect(r).toEqual({ ok: false, reason: "ANOTHER_THREAD_OPEN", openConversationId: "cv-open" })
  expect(prisma.conversation.findFirst).toHaveBeenNthCalledWith(2, {
    where: { tenantId: "t1", contactId: "ct1", closedAt: null, id: { not: "cv1" } },
    select: { id: true },
  })
  // Refusal is BEFORE the write, and nothing is audited.
  expect(prisma.conversation.updateMany).not.toHaveBeenCalled()
  expect(logAudit).not.toHaveBeenCalled()
})

it("setConversationStatus reopens a closed thread when no sibling is open", async () => {
  vi.mocked(prisma.conversation.findFirst)
    .mockResolvedValueOnce({ contactId: "ct1", closedAt: new Date("2026-07-01T00:00:00.000Z") } as any)
    .mockResolvedValueOnce(null as any)
  vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 1 } as any)

  const r = await setConversationStatus({ tenantId: "t1", conversationId: "cv1", status: "PENDING_CUSTOMER", actorUserId: "u1", now })

  expect(r).toEqual({ ok: true })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CONVERSATION_STATUS_CHANGED" }))
})

it("setConversationStatus maps a racing P2002 on the index to ANOTHER_THREAD_OPEN", async () => {
  // TOCTOU: the pre-check saw no sibling, then a concurrent inbound opened one.
  vi.mocked(prisma.conversation.findFirst)
    .mockResolvedValueOnce({ contactId: "ct1", closedAt: new Date("2026-07-01T00:00:00.000Z") } as any)
    .mockResolvedValueOnce(null as any)
    .mockResolvedValueOnce({ id: "cv-raced" } as any)
  vi.mocked(prisma.conversation.updateMany).mockRejectedValue(
    Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: "Conversation_one_open_per_contact" },
    }),
  )

  const r = await setConversationStatus({ tenantId: "t1", conversationId: "cv1", status: "OPEN", actorUserId: "u1", now })

  expect(r).toEqual({ ok: false, reason: "ANOTHER_THREAD_OPEN", openConversationId: "cv-raced" })
  expect(logAudit).not.toHaveBeenCalled()
})

it("setConversationStatus rethrows a P2002 on some OTHER constraint", async () => {
  vi.mocked(prisma.conversation.findFirst)
    .mockResolvedValueOnce({ contactId: "ct1", closedAt: null } as any)
  vi.mocked(prisma.conversation.updateMany).mockRejectedValue(
    Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["someOtherIndex"] } }),
  )

  await expect(
    setConversationStatus({ tenantId: "t1", conversationId: "cv1", status: "OPEN", actorUserId: "u1", now }),
  ).rejects.toThrow("Unique constraint failed")
})

it("setConversationStatus returns NOT_FOUND for a conversation in another tenant", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
  const r = await setConversationStatus({ tenantId: "t1", conversationId: "cv1", status: "OPEN", actorUserId: "u1", now })
  expect(r).toEqual({ ok: false, reason: "NOT_FOUND" })
  expect(prisma.conversation.updateMany).not.toHaveBeenCalled()
})

it("setConversationPriority updates + audits", async () => {
  vi.mocked(prisma.conversation.updateMany).mockResolvedValue({ count: 1 } as any)
  const r = await setConversationPriority({ tenantId: "t1", conversationId: "cv1", priority: "URGENT", actorUserId: "u1" })
  expect(r).toEqual({ ok: true })
  expect(prisma.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" }, data: { priority: "URGENT" } })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CONVERSATION_PRIORITY_CHANGED" }))
})
