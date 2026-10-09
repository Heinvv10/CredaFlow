import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

import { MessageBubble } from "./MessageBubble"
import { resetMentionableStaffCache } from "@/lib/inbox/mentionable-staff"
import type { ThreadMessage } from "./types"

// Mentions in the inline note EDITOR. The composer's picker shipped first; the
// edit box had none, so a staffer could only tag someone while first WRITING a
// note. Editing one to add "@Bo please chase" left a note that reads tagged
// while nobody is notified — the same failure mode the keyboard handling fixed
// on the composer.
const staff = [
  { id: "u2", name: "Bo Nkosi", email: "bo@x.co" },
  { id: "u3", name: "Cy Dlamini", email: "cy@x.co" },
]

const note = {
  id: "n1", direction: "INTERNAL_NOTE", isInternal: true, bodyText: "chased twice",
  status: "QUEUED", provider: "MANUAL", channel: "EMAIL", hasMedia: false,
  errorMessage: null, errorClass: null, dispatchState: null, dispatchLeaseExpiresAt: null,
  templateId: null, createdById: "u1", createdByName: "Ana",
  createdAt: "2026-08-13T10:00:00.000Z", sentAt: null, deliveredAt: null, readAt: null,
  editedAt: null, deletedAt: null, deletedByName: null, mentions: [],
} as unknown as ThreadMessage

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

describe("MessageBubble note-edit mentions", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    // The roster cache is MODULE-level by design, so it outlives a test:
    // vitest isolates per file, not per test. Without this every test after the
    // first would silently assert against a warm cache.
    resetMentionableStaffCache()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => staff }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  function button(renderer: ReactTestRenderer, text: string) {
    return renderer.root.findAllByType("button").find((b) => b.props.children === text)!
  }

  // The picker's rows are the only buttons labelled with a staff member, so
  // this proves both that the picker rendered AND which rows survived the filter.
  function pickerRows(renderer: ReactTestRenderer): string[] {
    const labels = new Set(staff.flatMap((s) => [s.name, s.email]))
    return renderer.root
      .findAllByType("button")
      .map((b) => b.props.children as string)
      .filter((label) => labels.has(label))
  }

  function textarea(renderer: ReactTestRenderer) {
    return renderer.root.findByType("textarea")
  }

  async function openEditor(overrides: Partial<ThreadMessage>, onEditNote = vi.fn()) {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <MessageBubble
          message={{ ...note, ...overrides } as ThreadMessage}
          currentUserId="u1"
          onEditNote={onEditNote}
          onDeleteNote={vi.fn()}
        />,
      )
    })
    await act(async () => { button(renderer, "Edit").props.onClick() })
    return { renderer, onEditNote }
  }

  async function type(renderer: ReactTestRenderer, value: string, selectionStart?: number) {
    await act(async () => {
      textarea(renderer).props.onChange({
        target: selectionStart === undefined ? { value } : { value, selectionStart },
      })
    })
  }

  async function keyDown(renderer: ReactTestRenderer, key: string) {
    const preventDefault = vi.fn()
    await act(async () => { textarea(renderer).props.onKeyDown({ key, preventDefault }) })
    return preventDefault
  }

  // Asserting the LABEL appears in the text proves nothing about who gets a
  // bell — the id in the payload is the whole point.
  it("picking a row with the mouse sends that id to the edit caller", async () => {
    const { renderer, onEditNote } = await openEditor({})
    await type(renderer, "chased twice @cy")

    await act(async () => { button(renderer, "Cy Dlamini").props.onClick() })
    expect(textarea(renderer).props.value).toBe("chased twice @Cy Dlamini ")
    // The trailing space closes the run, so the picker must not stay open.
    expect(pickerRows(renderer)).toEqual([])

    await act(async () => { button(renderer, "Save").props.onClick() })

    expect(onEditNote).toHaveBeenCalledWith("n1", "chased twice @Cy Dlamini", ["u3"])
  })

  it("opens the picker filtered by the run after @", async () => {
    const { renderer } = await openEditor({})

    await type(renderer, "chased twice @bo")

    expect(fetch).toHaveBeenCalledWith("/api/staff/mentionable")
    expect(pickerRows(renderer)).toEqual(["Bo Nkosi"])
  })

  // Without this a keyboard-only staffer cannot tag anyone from the edit box:
  // typing "@Cy Dlamini" by hand never records the pick.
  it("ArrowDown then Enter selects a row and does NOT save the note", async () => {
    const { renderer, onEditNote } = await openEditor({})
    await type(renderer, "chased twice @")
    expect(pickerRows(renderer)).toEqual(["Bo Nkosi", "Cy Dlamini"])

    await keyDown(renderer, "ArrowDown")
    const prevented = await keyDown(renderer, "Enter")

    expect(textarea(renderer).props.value).toBe("chased twice @Cy Dlamini ")
    expect(prevented).toHaveBeenCalled()
    // Selecting is not saving: the editor is still open and nothing was sent.
    expect(onEditNote).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType("textarea")).toHaveLength(1)

    await act(async () => { button(renderer, "Save").props.onClick() })

    expect(onEditNote).toHaveBeenCalledWith("n1", "chased twice @Cy Dlamini", ["u3"])
  })

  it("clamps ArrowUp at the first row rather than wrapping to the last", async () => {
    const { renderer } = await openEditor({})
    await type(renderer, "@")

    await keyDown(renderer, "ArrowUp")

    const active = renderer.root
      .findAllByType("button")
      .filter((b) => b.props["aria-selected"] === true)
      .map((b) => b.props.children)
    expect(active).toEqual(["Bo Nkosi"])
  })

  it("Escape closes the picker without touching the note text", async () => {
    const { renderer } = await openEditor({})
    await type(renderer, "chased twice @bo")
    expect(pickerRows(renderer)).toEqual(["Bo Nkosi"])

    const prevented = await keyDown(renderer, "Escape")

    expect(pickerRows(renderer)).toEqual([])
    expect(textarea(renderer).props.value).toBe("chased twice @bo")
    expect(prevented).toHaveBeenCalled()
  })

  // The edit session has to be SEEDED from the persisted rows. Without that,
  // saving a note whose wording changed by one word would drop every mention it
  // already had. The server treats them as additive and notifies only newly
  // added ids, so re-sending is correct and re-pings nobody.
  it("keeps an existing mention through an edit that never touched it", async () => {
    const { renderer, onEditNote } = await openEditor({
      bodyText: "@Bo Nkosi please chase",
      mentions: [{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }],
    } as Partial<ThreadMessage>)

    await type(renderer, "@Bo Nkosi please chase today")
    await act(async () => { button(renderer, "Save").props.onClick() })

    expect(onEditNote).toHaveBeenCalledWith("n1", "@Bo Nkosi please chase today", ["u2"])
  })

  it("sends an existing mention on a save that changed nothing at all", async () => {
    const { renderer, onEditNote } = await openEditor({
      bodyText: "@Bo Nkosi please chase",
      mentions: [{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }],
    } as Partial<ThreadMessage>)

    await act(async () => { button(renderer, "Save").props.onClick() })

    expect(onEditNote).toHaveBeenCalledWith("n1", "@Bo Nkosi please chase", ["u2"])
  })

  // The stale-mention filter, on the edit path: deleting the visible "@Bo Nkosi"
  // must not still ping him.
  it("drops a mention the staffer deleted from the text", async () => {
    const { renderer, onEditNote } = await openEditor({
      bodyText: "@Bo Nkosi please chase",
      mentions: [{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }],
    } as Partial<ThreadMessage>)

    await type(renderer, "never mind, handled")
    await act(async () => { button(renderer, "Save").props.onClick() })

    expect(onEditNote).toHaveBeenCalledWith("n1", "never mind, handled", [])
  })

  it("keeps the mention that is still visible when one of two is deleted", async () => {
    const { renderer, onEditNote } = await openEditor({
      bodyText: "@Bo Nkosi @Cy Dlamini please chase",
      mentions: [
        { userId: "u2", name: "Bo Nkosi", email: "bo@x.co" },
        { userId: "u3", name: "Cy Dlamini", email: "cy@x.co" },
      ],
    } as Partial<ThreadMessage>)

    await type(renderer, "@Cy Dlamini please chase")
    await act(async () => { button(renderer, "Save").props.onClick() })

    expect(onEditNote).toHaveBeenCalledWith("n1", "@Cy Dlamini please chase", ["u3"])
  })

  // A newly picked mention has to reach the payload ALONGSIDE the seeded ones,
  // not replace them.
  it("adds a newly picked mention to the ones the note already had", async () => {
    const { renderer, onEditNote } = await openEditor({
      bodyText: "@Bo Nkosi please chase",
      mentions: [{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }],
    } as Partial<ThreadMessage>)

    await type(renderer, "@Bo Nkosi please chase @cy")
    await act(async () => { button(renderer, "Cy Dlamini").props.onClick() })
    await act(async () => { button(renderer, "Save").props.onClick() })

    expect(onEditNote).toHaveBeenCalledWith("n1", "@Bo Nkosi please chase @Cy Dlamini", ["u2", "u3"])
  })

  // THE module-cache test. A thread with twenty notes mounts twenty bubbles; an
  // instance-level cache passes every single-bubble test above while firing one
  // identical request per bubble the staffer opens.
  it("fetches the roster at most once across two mounted bubbles", async () => {
    const onEditNote = vi.fn()
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <>
          <MessageBubble message={note} currentUserId="u1" onEditNote={onEditNote} />
          <MessageBubble
            message={{ ...note, id: "n2", bodyText: "also chased" } as ThreadMessage}
            currentUserId="u1"
            onEditNote={onEditNote}
          />
        </>,
      )
    })
    const editButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Edit")
    expect(editButtons).toHaveLength(2)
    await act(async () => { editButtons[0].props.onClick() })
    await act(async () => { editButtons[1].props.onClick() })

    const boxes = renderer.root.findAllByType("textarea")
    expect(boxes).toHaveLength(2)
    await act(async () => { boxes[0].props.onChange({ target: { value: "chased twice @bo" } }) })
    await act(async () => { boxes[1].props.onChange({ target: { value: "also chased @cy" } }) })

    expect(fetch).toHaveBeenCalledTimes(1)
    // Both bubbles are still usable — the shared promise has to resolve into
    // each one's state, not merely suppress the second request.
    expect(pickerRows(renderer)).toEqual(["Bo Nkosi", "Cy Dlamini"])
  })

  it("shares the cached roster with a bubble mounted after the first fetch resolved", async () => {
    const first = await openEditor({})
    await type(first.renderer, "chased twice @bo")
    expect(pickerRows(first.renderer)).toEqual(["Bo Nkosi"])

    let second!: ReactTestRenderer
    await act(async () => {
      second = create(
        <MessageBubble
          message={{ ...note, id: "n2" } as ThreadMessage}
          currentUserId="u1"
          onEditNote={vi.fn()}
        />,
      )
    })
    await act(async () => { button(second, "Edit").props.onClick() })
    await act(async () => { second.root.findByType("textarea").props.onChange({ target: { value: "@cy" } }) })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(pickerRows(second)).toEqual(["Cy Dlamini"])
  })

  // Losing the roster costs the autocomplete, not the note: the staffer can
  // still type the name by hand and save.
  it("stays a usable editor when the roster fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    const { renderer, onEditNote } = await openEditor({})

    await type(renderer, "@cy still no bureau reply")
    await act(async () => { button(renderer, "Save").props.onClick() })

    expect(pickerRows(renderer)).toEqual([])
    expect(onEditNote).toHaveBeenCalledWith("n1", "@cy still no bureau reply", [])
  })

  it("never opens the picker on a note that is not being edited", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <MessageBubble
          message={{ ...note, bodyText: "mail us at @cy" } as ThreadMessage}
          currentUserId="u1"
          onEditNote={vi.fn()}
        />,
      )
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(pickerRows(renderer)).toEqual([])
  })
})
