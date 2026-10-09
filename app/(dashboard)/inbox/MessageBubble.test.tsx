import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { act, create, type ReactTestRenderer } from "react-test-renderer"

vi.mock("@/lib/messaging/reconciliation", () => ({ requiresMessageReconciliation: () => true }))
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

import { MessageBubble } from "./MessageBubble"
import type { ThreadMessage } from "./types"

const message = {
  id: "message-1",
  direction: "OUTBOUND",
  status: "QUEUED",
  bodyText: "Hello",
  createdAt: "2026-07-22T12:00:00.000Z",
  isInternal: false,
  hasMedia: false,
} as never

describe("MessageBubble reconciliation affordance", () => {
  it("shows the warning but no privileged Resolve link by default", () => {
    const html = renderToStaticMarkup(<MessageBubble message={message} />)
    expect(html).toContain("Manual reconciliation required")
    expect(html).not.toContain("Resolve")
    expect(html).not.toContain("/inbox/reconciliation")
  })

  it("shows Resolve only when the server-authorized capability is passed", () => {
    const html = renderToStaticMarkup(<MessageBubble message={message} canReconcile />)
    expect(html).toContain("Resolve")
    expect(html).toContain("/inbox/reconciliation?messageId=message-1")
  })
})

// Note edit/delete affordances. renderToStaticMarkup (not react-test-renderer):
// these assertions only need presence/absence of rendered text, matching the
// pattern already used above in this file — @testing-library/react is not a
// dependency of this repo.
const note = {
  id: "n1", direction: "INTERNAL_NOTE", isInternal: true, bodyText: "chased twice",
  status: "QUEUED", provider: "MANUAL", channel: "EMAIL", hasMedia: false,
  errorMessage: null, errorClass: null, dispatchState: null, dispatchLeaseExpiresAt: null,
  templateId: null, createdById: "u1", createdByName: "Ana",
  createdAt: "2026-08-13T10:00:00.000Z", sentAt: null, deliveredAt: null, readAt: null,
  editedAt: null, deletedAt: null, deletedByName: null, mentions: [],
} as unknown as ThreadMessage

describe("MessageBubble note edit/delete affordances", () => {
  it("offers edit and delete to the note's author", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={note} currentUserId="u1" onEditNote={() => {}} onDeleteNote={() => {}} />,
    )
    expect(html).toContain("Edit")
    expect(html).toContain("Delete")
  })

  it("offers neither to anyone else", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={note} currentUserId="u2" onEditNote={() => {}} onDeleteNote={() => {}} />,
    )
    expect(html).not.toContain("Edit")
    expect(html).not.toContain("Delete")
  })

  it("marks an edited note", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={{ ...note, editedAt: "2026-08-13T11:00:00.000Z" }} currentUserId="u2" />,
    )
    expect(html).toContain("edited")
  })

  it("renders a tombstone with no body for a deleted note", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{ ...note, bodyText: null, deletedAt: "2026-08-13T11:00:00.000Z", deletedByName: "Ana" }}
        currentUserId="u1"
        onEditNote={() => {}}
        onDeleteNote={() => {}}
      />,
    )
    expect(html).toContain("Note deleted by Ana")
    expect(html).not.toContain("chased twice")
    // A deleted note cannot be edited back into existence.
    expect(html).not.toContain("Edit")
  })
})

// Interaction tests: renderToStaticMarkup above only proves the buttons are
// present/absent in the markup — it never clicks anything, so wiring like
// "Save passes the wrong id" or "Cancel calls onEditNote anyway" would pass
// those tests undetected. react-test-renderer + act actually drives clicks
// and asserts on the handler calls, matching the pattern in
// components/comms/ClientCommsTab.test.tsx (no @testing-library/react here).
function renderNote(overrides: Partial<ThreadMessage> = {}, props: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      <MessageBubble message={{ ...note, ...overrides } as ThreadMessage} currentUserId="u1" {...props} />,
    )
  })
  return renderer
}

function findButton(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button").find((b) => b.props.children === text)
}

describe("MessageBubble note edit/delete interactions", () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })

  it("clicking Edit renders a textarea containing the note's current text", () => {
    const renderer = renderNote({}, { onEditNote: vi.fn(), onDeleteNote: vi.fn() })

    act(() => { findButton(renderer, "Edit")!.props.onClick() })

    expect(renderer.root.findByType("textarea").props.value).toBe("chased twice")
  })

  // The third argument is the mention list the edit will send. This fixture's
  // note has none, so an empty array is the whole payload — the mention cases
  // are driven in MessageBubbleMentions.test.tsx.
  it("editing the textarea and clicking Save calls onEditNote once with (id, new text, mentions)", () => {
    const onEditNote = vi.fn()
    const renderer = renderNote({}, { onEditNote, onDeleteNote: vi.fn() })
    act(() => { findButton(renderer, "Edit")!.props.onClick() })
    act(() => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "chased three times" } })
    })

    act(() => { findButton(renderer, "Save")!.props.onClick() })

    expect(onEditNote).toHaveBeenCalledTimes(1)
    expect(onEditNote).toHaveBeenCalledWith("n1", "chased three times", [])
  })

  it("clicking Delete calls onDeleteNote once with the note's id", () => {
    const onDeleteNote = vi.fn()
    const renderer = renderNote({}, { onEditNote: vi.fn(), onDeleteNote })

    act(() => { findButton(renderer, "Delete")!.props.onClick() })

    expect(onDeleteNote).toHaveBeenCalledTimes(1)
    expect(onDeleteNote).toHaveBeenCalledWith("n1")
  })

  it("clicking Edit then Cancel restores the original text and never calls onEditNote", () => {
    const onEditNote = vi.fn()
    const renderer = renderNote({}, { onEditNote, onDeleteNote: vi.fn() })
    act(() => { findButton(renderer, "Edit")!.props.onClick() })
    act(() => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "garbage draft" } })
    })

    act(() => { findButton(renderer, "Cancel")!.props.onClick() })

    expect(onEditNote).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType("textarea").length).toBe(0)
    expect(JSON.stringify(renderer.toJSON())).toContain("chased twice")
  })

  it("a non-author has no Edit or Delete control to click", () => {
    const onEditNote = vi.fn()
    const onDeleteNote = vi.fn()
    const renderer = renderNote({}, { currentUserId: "u2", onEditNote, onDeleteNote })

    expect(findButton(renderer, "Edit")).toBeUndefined()
    expect(findButton(renderer, "Delete")).toBeUndefined()
    expect(onEditNote).not.toHaveBeenCalled()
    expect(onDeleteNote).not.toHaveBeenCalled()
  })
})

// Mention highlighting. Asserts on the span that actually wraps the mention —
// the note header ("Note · Ana:") is already font-medium, so "some span is
// font-medium" would pass with no highlighting at all.
function mentionSpans(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType("span")
    .filter((s) => typeof s.props.children === "string" && (s.props.className ?? "").includes("text-amber-700"))
    .map((s) => ({ text: s.props.children as string, className: s.props.className as string }))
}

// Every leaf span's text. The body is now a run of sibling spans (one per
// segment), so this is what proves no segment was dropped on the floor.
function bodySpanText(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType("span")
    .map((s) => s.props.children)
    .filter((c): c is string => typeof c === "string")
}

describe("MessageBubble mention highlighting", () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })

  it("highlights a mentioned name", () => {
    const renderer = renderNote({
      bodyText: "@Bo Nkosi please chase",
      mentions: [{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }],
    })

    expect(mentionSpans(renderer).map((s) => s.text)).toEqual(["@Bo Nkosi"])
    expect(mentionSpans(renderer)[0].className).toContain("font-medium")
  })

  it("leaves the rest of the note as plain text", () => {
    const renderer = renderNote({
      bodyText: "@Bo Nkosi please chase",
      mentions: [{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }],
    })

    // Both segments still render — highlighting must not swallow the note body.
    expect(mentionSpans(renderer)).toHaveLength(1)
    expect(bodySpanText(renderer)).toContain("@Bo Nkosi")
    expect(bodySpanText(renderer)).toContain(" please chase")
    expect(mentionSpans(renderer).map((s) => s.text)).toEqual(["@Bo Nkosi"])
    expect(mentionSpans(renderer).map((s) => s.text)).not.toContain(" please chase")
  })

  it("highlights nothing in a note with no mentions", () => {
    const renderer = renderNote({ bodyText: "chased twice", mentions: [] })

    expect(mentionSpans(renderer)).toEqual([])
    expect(bodySpanText(renderer)).toContain("chased twice")
  })

  it("only highlights the name that was actually mentioned", () => {
    const renderer = renderNote({
      bodyText: "@Bo Nkosi and @Cy Dlamini",
      mentions: [{ userId: "u3", name: "Cy Dlamini", email: "cy@x.co" }],
    })

    expect(mentionSpans(renderer).map((s) => s.text)).toEqual(["@Cy Dlamini"])
  })

  // Phase 2 redaction: toThreadMessage nulls bodyText for a soft-deleted note so
  // the text never ships in the page payload. Highlighting must not crash on
  // that, and must not resurrect the note.
  it("still renders the tombstone for a deleted note that had mentions", () => {
    const renderer = renderNote({
      bodyText: null,
      deletedAt: "2026-08-13T11:00:00.000Z",
      deletedByName: "Ana",
      mentions: [{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }],
    })

    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("Note deleted by")
    expect(json).toContain("Ana")
    expect(json).not.toContain("@Bo Nkosi")
    expect(mentionSpans(renderer)).toEqual([])
  })

  it("renders a null body without crashing", () => {
    const renderer = renderNote({ bodyText: null, mentions: [{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }] })

    expect(mentionSpans(renderer)).toEqual([])
  })

  // name: "" (not null) on purpose — an empty display name is what would turn
  // the label into a bare "@" and highlight every @ in the note. With `null`
  // the label is "@null", which this fixture doesn't contain, so the test would
  // pass whether the guard existed or not.
  it("does not highlight a bare @ for a mention with an empty name", () => {
    const renderer = renderNote({ bodyText: "@ nobody", mentions: [{ userId: "u2", name: "", email: "bo@x.co" }] })

    expect(mentionSpans(renderer)).toEqual([])
  })

  // The picker inserts "@email" for a staffer who never set a display name, so
  // the email is the label that is actually in the note body. Highlighting only
  // `name` left exactly those mentions rendered as plain text, while the bell
  // and the email notification still fired.
  it("highlights the email label for a mentioned staffer with no name", () => {
    const renderer = renderNote({
      bodyText: "@dee@x.co please chase",
      mentions: [{ userId: "u4", name: null, email: "dee@x.co" }],
    })

    expect(mentionSpans(renderer).map((s) => s.text)).toEqual(["@dee@x.co"])
    expect(bodySpanText(renderer)).toContain(" please chase")
  })
})

// One thread carries every channel, so each customer-facing bubble says how it
// travelled. Notes are staff-only and carry the thread's opening channel, so
// they must not claim one.
describe("MessageBubble channel tag", () => {
  const sent = (channel: string, direction = "OUTBOUND") =>
    ({ ...(message as object), channel, direction, status: "SENT" }) as never

  it.each([
    ["WHATSAPP", "WhatsApp"],
    ["EMAIL", "Email"],
    ["SMS", "SMS"],
  ])("labels a %s message %s", (channel, label) => {
    const html = renderToStaticMarkup(<MessageBubble message={sent(channel)} />)
    expect(html).toContain(`data-testid="message-channel">${label}<`)
  })

  it("labels inbound messages too", () => {
    const html = renderToStaticMarkup(<MessageBubble message={sent("WHATSAPP", "INBOUND")} />)
    expect(html).toContain(`data-testid="message-channel">WhatsApp<`)
  })

  it("does not tag an internal note with a channel", () => {
    const html = renderToStaticMarkup(<MessageBubble message={note} />)
    expect(html).not.toContain("message-channel")
  })
})
