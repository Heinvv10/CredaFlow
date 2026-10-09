import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageBubble } from "./MessageBubble"
import type { ThreadMessage } from "./types"

const note = (bodyText: string, mentions: ThreadMessage["mentions"] = []) => ({
  id: "n1", direction: "INTERNAL_NOTE", isInternal: true, bodyText,
  status: "DELIVERED", provider: "MANUAL", channel: "CHATBOT", hasMedia: false,
  errorMessage: null, errorClass: null, dispatchState: null, dispatchLeaseExpiresAt: null,
  templateId: null, createdById: null, createdByName: null,
  createdAt: "2026-09-30T10:00:00.000Z", sentAt: null, deliveredAt: null, readAt: null,
  editedAt: null, deletedAt: null, deletedByName: null, mentions,
}) as unknown as ThreadMessage

describe("MessageBubble note links", () => {
  it("renders the chat's lead and inbox paths as plain same-origin links", () => {
    const html = renderToStaticMarkup(<MessageBubble message={note("CRM lead: /crm/leads/lead_1\nInbox thread: /inbox?conversationId=conv_1")} />)
    expect(html).toContain('<a href="/crm/leads/lead_1"')
    expect(html).toContain('<a href="/inbox?conversationId=conv_1"')
  })

  it("leaves any other URL in a note as text, including a bare app path with no label", () => {
    const html = renderToStaticMarkup(<MessageBubble message={note("see https://evil.example/crm/leads/x and /admin and /crm/leads/y")} />)
    expect(html).not.toContain("<a ")
  })

  it("does not link paths in a customer's message", () => {
    const inbound = { ...note("CRM lead: /crm/leads/lead_1"), direction: "INBOUND", isInternal: false } as ThreadMessage
    expect(renderToStaticMarkup(<MessageBubble message={inbound} />)).not.toContain("<a ")
  })

  it("still highlights mentions alongside links", () => {
    const html = renderToStaticMarkup(<MessageBubble message={note("@Ana call back\nCRM lead: /crm/leads/lead_1", [{ userId: "u1", name: "Ana", email: null }] as never)} />)
    expect(html).toContain('<span class="font-medium text-amber-700">@Ana</span>')
    expect(html).toContain('<a href="/crm/leads/lead_1"')
  })
})
