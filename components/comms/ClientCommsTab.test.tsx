// @vitest-environment jsdom
// next/link's use-intersection hook touches `self`/`requestIdleCallback`, which
// the default "node" environment doesn't provide.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ClientCommsTab } from "./ClientCommsTab"
import type { ContactComms } from "@/lib/inbox/contact-comms"
import { resetMentionableStaffCache } from "@/lib/inbox/mentionable-staff"

// react-test-renderer, not @testing-library/react: the latter isn't a
// dependency of this repo (see Composer.test.tsx / NotificationsSettingsClient.test.tsx
// for the same pattern).
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer

const comms: ContactComms = {
  conversations: [{ id: "cv1", channel: "EMAIL", status: "OPEN", subject: "Re: loan", messageCount: 1 }],
  messages: [],
  channelAvailability: {
    EMAIL: { enabled: true }, WHATSAPP: { enabled: true }, SMS: { enabled: true },
  },
  waWindow: { open: false, expiresAt: null },
} as unknown as ContactComms

// An internal note on cv1, authored by the staffer the tab is rendered for —
// the only combination that offers an Edit control.
const noteMessage = {
  id: "n1", conversationId: "cv1", direction: "INTERNAL_NOTE", isInternal: true,
  bodyText: "chased twice", status: "QUEUED", channel: "EMAIL", hasMedia: false,
  createdById: "u1", createdByName: "Ana", createdAt: "2026-08-13T10:00:00.000Z",
  editedAt: null, deletedAt: null, deletedByName: null, mentions: [],
}

function render() {
  act(() => {
    renderer = create(<ClientCommsTab clientId="c1" hasContact comms={comms} cannedReplies={[]} />)
  })
  return renderer
}

function button(text: string) {
  return renderer.root.findAllByType("button").find((b) => b.props.children === text)!
}

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  act(() => renderer?.unmount())
  vi.unstubAllGlobals()
})

it("offers the internal note toggle on the client comms tab", () => {
  render()
  act(() => { button("Threads").props.onClick() })

  expect(button("Internal note")).toBeTruthy()
})

it("clears a stale send-failure banner once a note is added successfully", async () => {
  // Finding 3: addNote didn't clear `fallback` on entry (unlike sendReply),
  // so a successful note could sit under a leftover "Message could not be
  // sent right now." banner from an earlier failed reply — a false claim
  // about an action that just succeeded.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, json: async () => ({ reason: "SEND_FAILED" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "n1" }) })
  vi.stubGlobal("fetch", fetchMock)
  render()

  act(() => { button("Threads").props.onClick() })
  act(() => {
    renderer.root.findByType("textarea").props.onChange({ target: { value: "will this send?" } })
  })
  await act(async () => {
    await renderer.root.findAllByType("button").find((b) => b.props.children === "Send")!.props.onClick()
  })
  expect(JSON.stringify(renderer.toJSON())).toContain("Message could not be sent right now.")

  act(() => { button("Internal note").props.onClick() })
  act(() => {
    renderer.root.findByType("textarea").props.onChange({ target: { value: "chased twice, no answer" } })
  })
  await act(async () => { await button("Add note").props.onClick() })

  expect(JSON.stringify(renderer.toJSON())).not.toContain("Message could not be sent right now.")
})

// The edit box's picker is wired through ConversationView -> MessageBubble, and
// this is the terminal caller for the client tab: if the ids stop here the note
// is reworded and nobody is notified. Driven end to end (pick a row, save)
// rather than by calling editNote directly, because the wiring is the risk.
it("patches the picked mention id from the note edit box", async () => {
  resetMentionableStaffCache()
  const fetchMock = vi.fn().mockImplementation((url: string) =>
    url === "/api/staff/mentionable"
      ? Promise.resolve({ ok: true, json: async () => [{ id: "u3", name: "Cy Dlamini", email: "cy@x.co" }] })
      : Promise.resolve({ ok: true, json: async () => ({ ok: true, id: "n1" }) }),
  )
  vi.stubGlobal("fetch", fetchMock)
  act(() => {
    renderer = create(
      <ClientCommsTab
        clientId="c1"
        hasContact
        comms={{ ...comms, messages: [noteMessage] } as unknown as ContactComms}
        cannedReplies={[]}
        currentUserId="u1"
      />,
    )
  })

  act(() => { button("Threads").props.onClick() })
  act(() => { button("Edit").props.onClick() })
  // Two textareas once the editor is open: the note's, then the composer's.
  const editBox = renderer.root.findAllByType("textarea")[0]
  await act(async () => { editBox.props.onChange({ target: { value: "chased twice @cy" } }) })
  await act(async () => { button("Cy Dlamini").props.onClick() })
  await act(async () => { await button("Save").props.onClick() })

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/clients/c1/comms/threads/cv1/note/n1",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ text: "chased twice @Cy Dlamini", mentionUserIds: ["u3"] }),
    }),
  )
})

it("posts a note to the client-scoped route", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "n1" }) })
  vi.stubGlobal("fetch", fetchMock)
  render()

  act(() => { button("Threads").props.onClick() })
  act(() => { button("Internal note").props.onClick() })
  act(() => {
    renderer.root.findByType("textarea").props.onChange({ target: { value: "chased twice, no answer" } })
  })
  await act(async () => { await button("Add note").props.onClick() })

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/clients/c1/comms/threads/cv1/note",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ text: "chased twice, no answer", mentionUserIds: [] }),
    }),
  )
})

// The tab passes no takeover state and has no join button, so nothing typed here
// may reach a website visitor: a chat is read-only, whoever is looking at it.
it("offers no reply to a website chat visitor, only an internal note", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "n1" }) })
  vi.stubGlobal("fetch", fetchMock)
  const chat = {
    ...comms,
    conversations: [{ id: "cv9", channel: "CHATBOT", status: "OPEN", subject: "Website chat WC-ABC234", messageCount: 2 }],
    replyChannels: ["EMAIL", "WHATSAPP"],
  } as unknown as ContactComms
  act(() => {
    renderer = create(<ClientCommsTab clientId="c1" hasContact comms={chat} cannedReplies={[{ id: "r1", title: "Balance", body: "Your balance" }]} currentUserId="u1" />)
  })
  act(() => { button("Threads").props.onClick() })

  expect(JSON.stringify(renderer.toJSON())).toContain("The visitor can't receive replies here.")
  expect(button("Reply").props.disabled).toBe(true)
  expect(button("Send")).toBeUndefined()
  expect(renderer.root.findAll((n) => n.props["data-channel"] !== undefined)).toHaveLength(0)
  expect(renderer.root.findAllByType("select")).toHaveLength(0)

  // Clicking the disabled toggle changes nothing: what is typed is still a note.
  act(() => { button("Reply").props.onClick() })
  act(() => { renderer.root.findByType("textarea").props.onChange({ target: { value: "phoned the visitor" } }) })
  expect(button("Send")).toBeUndefined()
  await act(async () => { await button("Add note").props.onClick() })

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/clients/c1/comms/threads/cv9/note"])
})
