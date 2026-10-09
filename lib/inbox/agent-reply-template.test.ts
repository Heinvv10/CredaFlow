/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { messageTemplate: { upsert: vi.fn() } },
}))

import { getOrCreateAgentReplyTemplate, AGENT_REPLY_TEMPLATE_KEY } from "./agent-reply-template"
import { prisma } from "@/lib/prisma"

beforeEach(() => vi.clearAllMocks())

it("upserts the {{body}} SERVICE WhatsApp template (default channel)", async () => {
  vi.mocked(prisma.messageTemplate.upsert).mockResolvedValue({ id: "tpl1", key: AGENT_REPLY_TEMPLATE_KEY } as any)
  const tpl = await getOrCreateAgentReplyTemplate("t1")
  expect(tpl.id).toBe("tpl1")
  expect(prisma.messageTemplate.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { tenantId_key: { tenantId: "t1", key: AGENT_REPLY_TEMPLATE_KEY } },
      create: expect.objectContaining({
        tenantId: "t1",
        channel: "WHATSAPP",
        subject: null,
        body: "{{body}}",
        bodyTemplate: null,
        category: "SERVICE",
        product: "GENERAL",
        statutoryOverride: false,
        key: AGENT_REPLY_TEMPLATE_KEY,
      }),
    }),
  )
})

it("upserts a subject + HTML EMAIL template on its own key", async () => {
  vi.mocked(prisma.messageTemplate.upsert).mockResolvedValue({ id: "tpl2", key: "agent_freeform_reply_email" } as any)
  const tpl = await getOrCreateAgentReplyTemplate("t1", "EMAIL")
  expect(tpl.id).toBe("tpl2")
  expect(prisma.messageTemplate.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { tenantId_key: { tenantId: "t1", key: "agent_freeform_reply_email" } },
      create: expect.objectContaining({
        tenantId: "t1",
        channel: "EMAIL",
        subject: "{{subject}}",
        body: "{{body}}",
        bodyTemplate: "{{bodyHtml}}",
        category: "SERVICE",
        key: "agent_freeform_reply_email",
      }),
    }),
  )
})
