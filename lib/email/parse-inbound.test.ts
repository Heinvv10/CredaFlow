/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest"
import { parseInboundEmail, mapGraphMessage, htmlToPlainText } from "./parse-inbound"

const RAW = [
  "From: Jane Client <jane@example.com>",
  "To: noreply@lender.example",
  "Subject: Re: your application",
  "Message-ID: <reply-abc@example.com>",
  "In-Reply-To: <out-1@lender.example>",
  "References: <out-0@lender.example> <out-1@lender.example>",
  "Date: Tue, 07 Jul 2026 12:00:00 +0200",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Yes, please proceed.",
  "",
].join("\r\n")

describe("parseInboundEmail", () => {
  it("extracts threading headers, addresses, subject and body", async () => {
    const out = await parseInboundEmail(RAW)
    expect(out).not.toBeNull()
    expect(out!.providerMessageId).toBe("<reply-abc@example.com>")
    expect(out!.inReplyTo).toBe("<out-1@lender.example>")
    expect(out!.references).toEqual([
      "<out-0@lender.example>",
      "<out-1@lender.example>",
    ])
    expect(out!.fromAddress).toBe("jane@example.com")
    expect(out!.toAddress).toBe("noreply@lender.example")
    expect(out!.subject).toBe("Re: your application")
    expect(out!.bodyText).toContain("Yes, please proceed.")
    expect(out!.provider).toBe("SMTP")
    expect(out!.receivedAt.toISOString()).toBe("2026-07-07T10:00:00.000Z")
  })

  it("returns null when there is no Message-ID", async () => {
    const noId = RAW.replace("Message-ID: <reply-abc@example.com>\r\n", "")
    expect(await parseInboundEmail(noId)).toBeNull()
  })

  it("derives bodyText from HTML when there is no text/plain part", async () => {
    const htmlOnly = [
      "From: Jane Client <jane@example.com>",
      "To: noreply@lender.example",
      "Subject: Re: your application",
      "Message-ID: <reply-html@example.com>",
      "Date: Tue, 07 Jul 2026 12:00:00 +0200",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Yes, please <b>proceed</b>.</p>",
      "",
    ].join("\r\n")
    const out = await parseInboundEmail(htmlOnly)
    expect(out).not.toBeNull()
    expect(out!.bodyHtml).toContain("proceed")
    // bodyText (what the agent inbox renders) is no longer empty for HTML-only mail.
    expect(out!.bodyText).toContain("Yes, please")
    expect(out!.bodyText).toContain("proceed")
    expect(out!.bodyText).not.toContain("<")
  })
})

describe("htmlToPlainText", () => {
  it("strips tags, drops script/style, and decodes basic entities", () => {
    const html = "<style>p{color:red}</style><p>Hi&nbsp;Jane &amp; team</p><script>evil()</script><div>Line 2</div>"
    const text = htmlToPlainText(html)
    expect(text).toContain("Hi Jane & team")
    expect(text).toContain("Line 2")
    expect(text).not.toContain("evil()")
    expect(text).not.toContain("color:red")
    expect(text).not.toContain("<")
  })
})

const GRAPH_MSG = {
  id: "graph-1",
  subject: "Re: your application",
  from: { emailAddress: { address: "jane@example.com" } },
  toRecipients: [{ emailAddress: { address: "noreply@lender.example" } }],
  receivedDateTime: "2026-07-07T10:00:00Z",
  body: { contentType: "html", content: "<p>Yes</p>" },
  internetMessageId: "<reply-abc@example.com>",
  internetMessageHeaders: [
    { name: "In-Reply-To", value: "<out-1@lender.example>" },
    { name: "References", value: "<out-0@lender.example> <out-1@lender.example>" },
  ],
}

describe("mapGraphMessage", () => {
  it("maps a Graph message to InboundEmailInput", () => {
    const out = mapGraphMessage(GRAPH_MSG as any)
    expect(out).not.toBeNull()
    expect(out!.providerMessageId).toBe("<reply-abc@example.com>")
    expect(out!.inReplyTo).toBe("<out-1@lender.example>")
    expect(out!.references).toEqual([
      "<out-0@lender.example>",
      "<out-1@lender.example>",
    ])
    expect(out!.fromAddress).toBe("jane@example.com")
    expect(out!.bodyHtml).toBe("<p>Yes</p>")
    // HTML-only Graph body still yields readable bodyText for the inbox.
    expect(out!.bodyText).toBe("Yes")
    expect(out!.provider).toBe("MSGRAPH")
  })

  it("returns null with no internetMessageId", () => {
    const { internetMessageId: _internetMessageId, ...noId } = GRAPH_MSG
    expect(mapGraphMessage(noId as any)).toBeNull()
  })
})
