import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadView } from "./ThreadView"

const BANNER = "Visitor details are not verified. Do not discuss any account in this chat."
const REPLY_PLACEHOLDER = "Reply to the visitor in the website chat…"

function thread(conversation: { channel?: string; status?: string; assigneeId?: string | null; assigneeName?: string | null }) {
  const channel = conversation.channel ?? "CHATBOT"
  return {
    conversation: { id: "cv1", channel, status: "OPEN", priority: "NORMAL", assigneeId: null, assigneeName: null, ...conversation },
    contact: { displayName: "Thabo M" },
    linked: { loan: null, application: null },
    window: { open: true, expiresAt: null },
    messages: [],
    reply: channel === "CHATBOT"
      ? { availableChannels: [], defaultChannel: "CHATBOT" }
      : { availableChannels: ["WHATSAPP", "EMAIL"], defaultChannel: "WHATSAPP" },
  } as never
}

function html(conversation: Parameters<typeof thread>[0], canReleaseChats = false): string {
  return renderToStaticMarkup(
    <ThreadView
      thread={thread(conversation)}
      canReleaseChats={canReleaseChats}
      cannedReplies={[]}
      roster={[{ id: "u2", name: "Bo Nkosi", email: "bo@example.com", role: "ADMIN", isCommsAgent: true }]}
      currentUserId="u1"
      canReconcile={false}
      busy={false}
      fallback={null}
      onSend={vi.fn()} onNote={vi.fn()} onEditNote={vi.fn()} onDeleteNote={vi.fn()}
      onClaim={vi.fn()} onRelease={vi.fn()} onReassign={vi.fn()} onStatus={vi.fn()} onPriority={vi.fn()}
    />,
  )
}

describe("ThreadView on a website chat (CHATBOT) thread", () => {
  it("offers to join an unassigned chat and holds the composer to notes", () => {
    const out = html({})
    expect(out).toContain(">Join chat</button>")
    expect(out).not.toContain(">Claim</button>")
    expect(out).toContain("Join the chat to reply to the visitor.")
    expect(out).not.toContain(REPLY_PLACEHOLDER)
    expect(out).toContain("Add an internal note (never sent)…")
  })

  it("lets the staffer who joined reply in the chat, with no channel picker or 24h window", () => {
    const out = html({ assigneeId: "u1", assigneeName: "Ana Dube" })
    expect(out).toContain(">Leave chat</button>")
    expect(out).not.toContain(">Release</button>")
    expect(out).toContain(REPLY_PLACEHOLDER)
    expect(out).toContain('maxLength="2000"')
    expect(out).not.toContain("data-channel")
    expect(out).not.toContain("24h window")
    expect(out).not.toContain("Join the chat to reply")
  })

  it("names the colleague who holds the chat and offers neither join nor leave", () => {
    const out = html({ assigneeId: "u2", assigneeName: "Bo Nkosi" })
    expect(out).toContain("Taken by Bo Nkosi.")
    expect(out).not.toContain(REPLY_PLACEHOLDER)
    expect(out).not.toContain(">Join chat</button>")
    expect(out).not.toContain(">Leave chat</button>")
  })

  it("an admin can release a chat a colleague holds; nobody else is offered it, and never on a chat that is theirs or unassigned", () => {
    const RELEASE = ">Release chat</button>"
    expect(html({ assigneeId: "u2", assigneeName: "Bo Nkosi" }, true)).toContain(RELEASE)
    expect(html({ assigneeId: "u2", assigneeName: "Bo Nkosi" }, false)).not.toContain(RELEASE)
    expect(html({ assigneeId: "u1" }, true)).not.toContain(RELEASE)
    expect(html({}, true)).not.toContain(RELEASE)
    // Only website chats: any other thread is reassigned instead.
    expect(html({ channel: "WHATSAPP", assigneeId: "u2" }, true)).not.toContain(RELEASE)
  })

  it("falls back to a neutral line when the holder has no name", () => {
    expect(html({ assigneeId: "u2", assigneeName: null })).toContain("Taken by a colleague.")
  })

  it("holds an ended chat to notes even for the staffer who joined it, and offers no leave or release on it", () => {
    const out = html({ status: "CLOSED", assigneeId: "u1", assigneeName: "Ana Dube" })
    expect(out).toContain("This chat has ended.")
    expect(out).not.toContain(REPLY_PLACEHOLDER)
    expect(out).not.toContain(">Leave chat</button>")
    expect(html({ status: "CLOSED", assigneeId: "u2", assigneeName: "Bo Nkosi" }, true)).not.toContain(">Release chat</button>")
    // Any other channel keeps its Release on a closed thread.
    expect(html({ channel: "WHATSAPP", status: "CLOSED", assigneeId: "u1" })).toContain(">Release</button>")
  })

  it("does not offer to join an ended chat", () => {
    const out = html({ status: "CLOSED" })
    expect(out).toContain("This chat has ended.")
    expect(out).not.toContain(">Join chat</button>")
    expect(out).not.toContain("Join the chat to reply")
  })

  it("never offers reassignment, which the server refuses for website chats", () => {
    expect(html({})).not.toContain("Reassign…")
    expect(html({ assigneeId: "u1" })).not.toContain("Reassign…")
  })

  it.each([
    ["an unassigned", {}],
    ["a joined", { assigneeId: "u1" }],
    ["a colleague's", { assigneeId: "u2", assigneeName: "Bo Nkosi" }],
    ["an ended", { status: "CLOSED" }],
  ])("warns that the visitor is unverified on %s chat", (_label, conversation) => {
    expect(html(conversation)).toContain(BANNER)
  })
})

describe("ThreadView on any other thread", () => {
  it("keeps Claim and Reassign and shows no website-chat wording", () => {
    const out = html({ channel: "WHATSAPP" })
    expect(out).toContain(">Claim</button>")
    expect(out).toContain("Reassign…")
    expect(out).toContain("Type a reply…")
    expect(out).not.toContain(BANNER)
    expect(out).not.toContain("Join chat")
    expect(out).not.toContain("maxLength")
  })

  it("keeps Release for the assignee", () => {
    const out = html({ channel: "WHATSAPP", assigneeId: "u1", assigneeName: "Ana Dube" })
    expect(out).toContain(">Release</button>")
    expect(out).not.toContain("Leave chat")
  })
})
