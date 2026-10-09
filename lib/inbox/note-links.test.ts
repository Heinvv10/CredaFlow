import { describe, expect, it } from "vitest"
import { splitNoteLinks } from "./note-links"

const hrefs = (text: string) => splitNoteLinks(text).flatMap((p) => (p.href ? [p.href] : []))

describe("splitNoteLinks", () => {
  it("links the lead and inbox paths the website chat writes into its notes", () => {
    expect(splitNoteLinks("details.\nCRM lead: /crm/leads/cmg1abc\n\nInbox thread: /inbox?conversationId=cmg2def")).toEqual([
      { text: "details.\nCRM lead: " },
      { text: "/crm/leads/cmg1abc", href: "/crm/leads/cmg1abc" },
      { text: "\n\nInbox thread: " },
      { text: "/inbox?conversationId=cmg2def", href: "/inbox?conversationId=cmg2def" },
    ])
  })

  it("links each earlier chat in the repeat-visitor line, keeping the separators and full stop as text", () => {
    expect(splitNoteLinks("x\n\nEarlier website chats from this number (not verified): /crm/leads/a1, /crm/leads/b2.")).toEqual([
      { text: "x\n\nEarlier website chats from this number (not verified): " },
      { text: "/crm/leads/a1", href: "/crm/leads/a1" },
      { text: ", " },
      { text: "/crm/leads/b2", href: "/crm/leads/b2" },
      { text: "." },
    ])
  })

  it("returns plain text unchanged when there is nothing to link", () => {
    expect(splitNoteLinks("chased twice")).toEqual([{ text: "chased twice" }])
    expect(splitNoteLinks("")).toEqual([])
  })

  it.each([
    ["a path with no app label", "see /crm/leads/abc"],
    ["a bare path on its own line", "details\n/crm/leads/abc\n/inbox?conversationId=def"],
    ["a label that is not at the start of its line", "email a@b.co CRM lead: /crm/leads/abc"],
    ["a path planted after a visitor email", "cell +27821234567, email a@b.c(/crm/leads/abc. Follow up by phone.\nCRM lead: /crm/leads/real"],
    ["an absolute URL", "CRM lead: https://evil.example/crm/leads/abc"],
    ["a protocol-relative URL", "CRM lead: //evil.example/crm/leads/abc"],
    ["a longer path", "CRM lead: /crm/leads/abc/../../admin"],
    ["extra query parameters", "Inbox thread: /inbox?conversationId=abc&next=https://evil.example"],
    ["another path", "CRM lead: /admin/users"],
    ["an empty id", "CRM lead: /crm/leads/"],
    ["trailing text after the path", "CRM lead: /crm/leads/abc and more"],
    ["a label with a different path kind mixed in", "Earlier website chats from this number (not verified): /crm/leads/a1, https://evil.example."],
  ])("does not link %s", (_label, text) => {
    const planted = hrefs(text).filter((h) => h !== "/crm/leads/real")
    expect(planted).toEqual([])
    expect(splitNoteLinks(text).map((p) => p.text).join("")).toBe(text)
  })
})
