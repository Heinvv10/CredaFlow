import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

import { ActivityRow } from "./LeadTimelineRow"

const activity = (notes: string, subject = "Website chat started") => ({
  kind: "activity", id: "a1", type: "NOTE", subject, notes, createdAt: new Date("2026-09-30T10:00:00Z"),
}) as never

describe("ActivityRow notes", () => {
  it("links the website chat's inbox thread path from the lead", () => {
    const html = renderToStaticMarkup(<ActivityRow entry={activity("From: Thandi Mokoena (self-declared, not verified)\nInbox thread: /inbox?conversationId=conv_1")} />)
    expect(html).toContain('<a href="/inbox?conversationId=conv_1" class="underline break-all"')
  })

  it("leaves any other URL in a note as text", () => {
    const html = renderToStaticMarkup(<ActivityRow entry={activity("Message: see /inbox?conversationId=abc (Inbox thread: /inbox?conversationId=def)")} />)
    expect(html).not.toContain("<a ")
  })

  it("does not link a labelled line in any other activity, e.g. a website contact-form message", () => {
    // The contact form keeps newlines, so a visitor can type the chat's own label line.
    const html = renderToStaticMarkup(<ActivityRow entry={activity("From: Eve\n\nMessage: hi\nInbox thread: /inbox?conversationId=abc", "Website enquiry")} />)
    expect(html).not.toContain("<a ")
  })
})
