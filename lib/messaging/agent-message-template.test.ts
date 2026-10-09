/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

const upsert = vi.fn()
vi.mock("@/lib/prisma", () => ({ prisma: { messageTemplate: { upsert: (a: any) => upsert(a) } } }))

import { getOrCreateAgentMessageTemplate } from "./agent-message-template"

describe("getOrCreateAgentMessageTemplate", () => {
  beforeEach(() => { upsert.mockReset(); upsert.mockResolvedValue({ id: "t1" }) })

  it("email template renders a subject + body, SERVICE category", async () => {
    await getOrCreateAgentMessageTemplate("tn1", "EMAIL")
    const arg = upsert.mock.calls[0][0]
    expect(arg.where.tenantId_key.key).toBe("agent_message_email")
    expect(arg.create.category).toBe("SERVICE")
    expect(arg.create.subject).toBe("{{subject}}")
    expect(arg.create.body).toBe("{{body}}")
    expect(arg.create.statutoryOverride).toBe(false)
  })

  it("whatsapp template has no subject", async () => {
    await getOrCreateAgentMessageTemplate("tn1", "WHATSAPP")
    const arg = upsert.mock.calls[0][0]
    expect(arg.where.tenantId_key.key).toBe("agent_message_whatsapp")
    expect(arg.create.subject).toBeNull()
    expect(arg.create.channel).toBe("WHATSAPP")
  })
})
