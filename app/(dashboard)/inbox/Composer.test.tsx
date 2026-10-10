import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./Composer"
import { resetMentionableStaffCache } from "@/lib/inbox/mentionable-staff"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function props(
  conversationId: string,
  onSend: (conversationId: string, text: string, operationId: string, channel: string) => Promise<boolean>,
) {
  return {
    conversationId,
    channel: "WHATSAPP",
    windowOpen: true,
    expiresAt: null,
    cannedReplies: [],
    sending: false,
    onSend,
    fallback: null,
    availableChannels: ["WHATSAPP", "EMAIL"],
    defaultChannel: "WHATSAPP",
  }
}

function textarea(renderer: ReactTestRenderer) {
  return renderer.root.findByType("textarea")
}

function sendButton(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((button) => button.props.children === "Send")!
}

function noteButton(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((button) => button.props.children === "Add note")!
}

function bannerText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

describe("Composer conversation-scoped operation keys", () => {
  let operationSequence = 0

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    operationSequence = 0
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => `operation-${++operationSequence}`),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("preserves distinct draft and retry keys across A to B to A thread switches", async () => {
    const onSend = vi.fn().mockResolvedValue(false)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("conversation-a", onSend)} />)
    })

    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "Message A" } })
      await sendButton(renderer).props.onClick()
    })
    const operationA = onSend.mock.calls[0]?.[2]

    await act(async () => {
      renderer.update(<Composer {...props("conversation-b", onSend)} />)
    })
    expect(textarea(renderer).props.value).toBe("")

    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "Message B" } })
      await sendButton(renderer).props.onClick()
    })
    const operationB = onSend.mock.calls[1]?.[2]
    expect(operationB).not.toBe(operationA)

    await act(async () => {
      renderer.update(<Composer {...props("conversation-a", onSend)} />)
    })
    expect(textarea(renderer).props.value).toBe("Message A")

    await act(async () => {
      await sendButton(renderer).props.onClick()
    })
    expect(onSend.mock.calls[2]).toEqual(["conversation-a", "Message A", operationA, "WHATSAPP"])

    await act(async () => renderer.unmount())
  })

  it("does not clear another thread when an earlier in-flight send completes", async () => {
    let resolveA!: (accepted: boolean) => void
    const onSend = vi.fn().mockImplementation((conversationId: string) => {
      if (conversationId === "conversation-a") {
        return new Promise<boolean>((resolve) => { resolveA = resolve })
      }
      return Promise.resolve(false)
    })
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("conversation-a", onSend)} />)
    })

    let pendingA!: Promise<void>
    act(() => {
      textarea(renderer).props.onChange({ target: { value: "Message A" } })
      pendingA = sendButton(renderer).props.onClick()
    })

    await act(async () => {
      renderer.update(<Composer {...props("conversation-b", onSend)} />)
    })
    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "Message B" } })
    })

    await act(async () => {
      resolveA(true)
      await pendingA
    })
    expect(textarea(renderer).props.value).toBe("Message B")

    await act(async () => {
      renderer.update(<Composer {...props("conversation-a", onSend)} />)
    })
    expect(textarea(renderer).props.value).toBe("")

    await act(async () => {
      renderer.update(<Composer {...props("conversation-b", onSend)} />)
    })
    expect(textarea(renderer).props.value).toBe("Message B")

    await act(async () => renderer.unmount())
  })

  it("retains the protected operation key when an unresolved reply is edited", async () => {
    const onSend = vi.fn().mockResolvedValue(false)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("conversation-a", onSend)} />)
    })

    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "Original payload" } })
      await sendButton(renderer).props.onClick()
    })
    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "Edited unresolved payload" } })
      await sendButton(renderer).props.onClick()
    })

    expect(onSend.mock.calls).toEqual([
      ["conversation-a", "Original payload", "operation-1", "WHATSAPP"],
      ["conversation-a", "Edited unresolved payload", "operation-1", "WHATSAPP"],
    ])
    expect(operationSequence).toBe(1)
    await act(async () => renderer.unmount())
  })
})

describe("Composer internal notes on a non-reply channel (SMS)", () => {
  beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(() => { delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

  // On SMS/voice, replyEnabled is false, so the composer forces
  // note mode. The fallback banner used to be gated on `replyEnabled`, which
  // meant a failed note here was completely silent — the staffer had no way
  // to tell their note wasn't recorded.
  it("shows the NOTE_FAILED banner when a note fails on an SMS thread", () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <Composer
          {...props("conversation-a", vi.fn())}
          channel="SMS" availableChannels={[]}
          onNote={vi.fn()}
          fallback={{ reason: "NOTE_FAILED" }}
        />,
      )
    })
    expect(bannerText(renderer)).toContain("Note could not be saved")
    act(() => renderer.unmount())
  })

  // The generic "reach the customer on another channel" suffix is
  // right for a failed send, but wrong for a failed internal note — the note
  // was never meant to reach the customer.
  it("omits the reach-the-customer suffix on a NOTE_FAILED banner", () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <Composer
          {...props("conversation-a", vi.fn())}
          channel="SMS" availableChannels={[]}
          onNote={vi.fn()}
          fallback={{ reason: "NOTE_FAILED" }}
        />,
      )
    })
    expect(bannerText(renderer)).not.toContain("Consider reaching the customer")
    act(() => renderer.unmount())
  })

  it("still shows the reach-the-customer suffix on a failed reply", () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <Composer {...props("conversation-a", vi.fn())} fallback={{ reason: "SEND_FAILED" }} />,
      )
    })
    expect(bannerText(renderer)).toContain("Consider reaching the customer")
    act(() => renderer.unmount())
  })

  // submit() used to call onNote fire-and-forget, then clear the
  // draft unconditionally on the next line — a failed note lost the typed
  // text with no way to retry it.
  it("passes an empty mention list for a note nobody was tagged in", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("conversation-a", vi.fn())} channel="SMS" availableChannels={[]} onNote={onNote} />)
    })

    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "client says he'll pay Friday" } })
    })
    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(onNote).toHaveBeenCalledWith("conversation-a", "client says he'll pay Friday", [])
    await act(async () => renderer.unmount())
  })

  it("keeps the note draft on failure and clears it only once the note is saved", async () => {
    let resolveNote!: (accepted: boolean) => void
    const onNote = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveNote = resolve }),
    )
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("conversation-a", vi.fn())} channel="SMS" availableChannels={[]} onNote={onNote} />)
    })

    act(() => {
      textarea(renderer).props.onChange({ target: { value: "client says he'll pay Friday" } })
    })

    let pending!: Promise<void>
    act(() => { pending = noteButton(renderer).props.onClick() })
    await act(async () => {
      resolveNote(false)
      await pending
    })
    expect(textarea(renderer).props.value).toBe("client says he'll pay Friday")

    let pending2!: Promise<void>
    act(() => { pending2 = noteButton(renderer).props.onClick() })
    await act(async () => {
      resolveNote(true)
      await pending2
    })
    expect(textarea(renderer).props.value).toBe("")

    await act(async () => renderer.unmount())
  })
})

describe("Composer mention autocomplete", () => {
  const actEnvironment2 = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const staff = [
    { id: "u2", name: "Bo Nkosi", email: "bo@x.co" },
    { id: "u3", name: "Cy Dlamini", email: "cy@x.co" },
  ]

  beforeEach(() => {
    actEnvironment2.IS_REACT_ACT_ENVIRONMENT = true
    // The roster cache is module-level and vitest isolates per FILE, not per
    // test, so without this the tests below that COUNT requests would measure a
    // cache warmed by an earlier test and assert nothing about this composer.
    resetMentionableStaffCache()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => staff }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment2.IS_REACT_ACT_ENVIRONMENT
  })

  // The picker's rows are the only buttons labelled with a staff member, so
  // this both proves the picker rendered AND which rows survived the filter.
  function pickerRows(renderer: ReactTestRenderer): string[] {
    const labels = new Set(staff.flatMap((s) => [s.name, s.email]))
    return renderer.root
      .findAllByType("button")
      .map((b) => b.props.children as string)
      .filter((label) => labels.has(label))
  }

  async function noteComposer(onNote = vi.fn().mockResolvedValue(true)) {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("conversation-a", vi.fn())} channel="SMS" availableChannels={[]} onNote={onNote} />)
    })
    return renderer
  }

  async function type(renderer: ReactTestRenderer, value: string, selectionStart?: number) {
    await act(async () => {
      textarea(renderer).props.onChange({
        target: selectionStart === undefined ? { value } : { value, selectionStart },
      })
    })
  }

  it("opens the picker filtered by the run after @ and fetches the roster", async () => {
    const renderer = await noteComposer()

    await type(renderer, "please look @cy")

    expect(fetch).toHaveBeenCalledWith("/api/staff/mentionable")
    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])
    await act(async () => renderer.unmount())
  })

  it("keeps the picker open across the space inside a two-word name", async () => {
    const renderer = await noteComposer()

    await type(renderer, "@Bo N")

    expect(pickerRows(renderer)).toEqual(["Bo Nkosi"])
    await act(async () => renderer.unmount())
  })

  it("closes the picker once the run stops looking like a name", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@Bo")
    expect(pickerRows(renderer)).toEqual(["Bo Nkosi"])

    await type(renderer, "@Bo Nkosi please chase")

    expect(pickerRows(renderer)).toEqual([])
    await act(async () => renderer.unmount())
  })

  it("never opens the picker in reply mode, only on a note", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    let renderer!: ReactTestRenderer
    await act(async () => {
      // WHATSAPP: replyEnabled, and noteMode defaults to false.
      renderer = create(<Composer {...props("conversation-a", vi.fn())} onNote={onNote} />)
    })

    await type(renderer, "mail us at @cy")

    expect(fetch).not.toHaveBeenCalled()
    expect(pickerRows(renderer)).toEqual([])
    await act(async () => renderer.unmount())
  })

  it("derives the run from the caret, not the end of the text", async () => {
    const renderer = await noteComposer()

    // Caret sits right after "@cy"; the later "@Bo Nkosi" is downstream of it.
    await type(renderer, "@cy and @Bo Nkosi", 3)

    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])
    await act(async () => renderer.unmount())
  })

  it("picking a row replaces the run with the label and pings that id on submit", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)
    await type(renderer, "please chase @cy")

    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Cy Dlamini")!.props.onClick()
    })
    expect(textarea(renderer).props.value).toBe("please chase @Cy Dlamini ")
    // The trailing space closes the run, so the picker must not stay open over
    // the textarea after a pick.
    expect(pickerRows(renderer)).toEqual([])

    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(onNote).toHaveBeenCalledWith("conversation-a", "please chase @Cy Dlamini", ["u3"])
    await act(async () => renderer.unmount())
  })

  it("inserts at the caret without truncating the rest of the note", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@cy — call the client", 3)

    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Cy Dlamini")!.props.onClick()
    })

    expect(textarea(renderer).props.value).toBe("@Cy Dlamini  — call the client")
    await act(async () => renderer.unmount())
  })

  // The stale-mention filter. Picking someone and then deleting the visible
  // "@Cy Dlamini" must not silently still ping her.
  it("drops a picked mention the agent deleted from the text before submitting", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)
    await type(renderer, "@cy")
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Cy Dlamini")!.props.onClick()
    })

    await type(renderer, "never mind, handled")
    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(onNote).toHaveBeenCalledWith("conversation-a", "never mind, handled", [])
    await act(async () => renderer.unmount())
  })

  it("keeps the mentions that are still visible when one of two is deleted", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)
    await type(renderer, "@cy")
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Cy Dlamini")!.props.onClick()
    })
    await type(renderer, "@Cy Dlamini @bo")
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Bo Nkosi")!.props.onClick()
    })
    expect(textarea(renderer).props.value).toBe("@Cy Dlamini @Bo Nkosi ")

    await type(renderer, "@Bo Nkosi only")
    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(onNote).toHaveBeenCalledWith("conversation-a", "@Bo Nkosi only", ["u2"])
    await act(async () => renderer.unmount())
  })

  // A half-written mention has to survive a thread switch exactly like the text.
  it("keeps picked mentions per conversation across a thread switch", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("conversation-a", vi.fn())} channel="SMS" availableChannels={[]} onNote={onNote} />)
    })
    await type(renderer, "@cy")
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Cy Dlamini")!.props.onClick()
    })

    await act(async () => {
      renderer.update(<Composer {...props("conversation-b", vi.fn())} channel="SMS" availableChannels={[]} onNote={onNote} />)
    })
    expect(textarea(renderer).props.value).toBe("")
    await act(async () => {
      renderer.update(<Composer {...props("conversation-a", vi.fn())} channel="SMS" availableChannels={[]} onNote={onNote} />)
    })
    expect(textarea(renderer).props.value).toBe("@Cy Dlamini ")

    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(onNote).toHaveBeenCalledWith("conversation-a", "@Cy Dlamini", ["u3"])
    await act(async () => renderer.unmount())
  })

  // Requirement on the lazy-fetch path: the picker must become usable when the
  // list LANDS, not merely have issued a request. Resolved by hand so the
  // in-flight state is observable.
  it("shows the picker once the roster lands, not merely when it is requested", async () => {
    let resolveRoster!: (r: unknown) => void
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((resolve) => { resolveRoster = resolve })))
    const renderer = await noteComposer()

    await type(renderer, "@cy")
    expect(fetch).toHaveBeenCalledWith("/api/staff/mentionable")
    expect(pickerRows(renderer)).toEqual([])

    await act(async () => { resolveRoster({ ok: true, json: async () => staff }) })

    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])
    await act(async () => renderer.unmount())
  })

  // One request, shared across every reopen of the query. Without the cache a
  // staffer who opens and closes a mention twice hits the roster twice.
  it("fetches the roster once across a closed and reopened query", async () => {
    const renderer = await noteComposer()

    await type(renderer, "@cy")
    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])
    await type(renderer, "no mention here")
    expect(pickerRows(renderer)).toEqual([])
    await type(renderer, "@bo")

    expect(fetch).toHaveBeenCalledTimes(1)
    // Still usable on the reopen — the cached promise has to resolve into state
    // again, not just suppress the second request.
    expect(pickerRows(renderer)).toEqual(["Bo Nkosi"])
    await act(async () => renderer.unmount())
  })

  // The stub shape at ClientCommsTab.test.tsx:56 — a bare vi.fn() returns
  // undefined, so `res.ok` throws inside the same try. Must degrade, not break.
  it("stays usable as a composer when fetch returns undefined", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)

    await type(renderer, "@cy chase the bureau reply")
    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(pickerRows(renderer)).toEqual([])
    expect(onNote).toHaveBeenCalledWith("conversation-a", "@cy chase the bureau reply", [])
    await act(async () => renderer.unmount())
  })

  // The roster includes the author, and
  // lib/inbox/notes.ts then drops the author from the resolved list — so picking
  // your own row inserts "@Me" and notifies nobody, silently.
  it("never offers the note's own author as a row", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer {...props("conversation-a", vi.fn())} channel="SMS" availableChannels={[]} onNote={vi.fn()} currentUserId="u2" />,
      )
    })

    await type(renderer, "@")
    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])
    await type(renderer, "@bo")
    expect(pickerRows(renderer)).toEqual([])

    await act(async () => renderer.unmount())
  })

  it("stays usable as a composer when the roster fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)

    await type(renderer, "@cy still no bureau reply")
    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(pickerRows(renderer)).toEqual([])
    expect(onNote).toHaveBeenCalledWith("conversation-a", "@cy still no bureau reply", [])
    await act(async () => renderer.unmount())
  })
})

// The design spec calls for the picker to be "a plain filtered <ul> ... with
// keyboard handling", and that clause was lost between spec and plan. It is not
// cosmetic: draft.mentions is populated ONLY by picking a row, so a staffer who
// types "@Bo Nkosi" by hand submits a note that reads as a tag while notifying
// nobody. Without arrow keys and Enter, a keyboard-only staffer cannot tag anyone.
describe("Composer mention keyboard handling", () => {
  const actEnvironment3 = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const staff = [
    { id: "u2", name: "Bo Nkosi", email: "bo@x.co" },
    { id: "u3", name: "Cy Dlamini", email: "cy@x.co" },
  ]

  beforeEach(() => {
    actEnvironment3.IS_REACT_ACT_ENVIRONMENT = true
    resetMentionableStaffCache()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => staff }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment3.IS_REACT_ACT_ENVIRONMENT
  })

  function pickerRows(renderer: ReactTestRenderer): string[] {
    const labels = new Set(staff.flatMap((s) => [s.name, s.email]))
    return renderer.root
      .findAllByType("button")
      .map((b) => b.props.children as string)
      .filter((label) => labels.has(label))
  }

  // The affordance the arrows move. Asserting on aria-selected rather than on
  // internal state, so a handler that updates nothing visible fails.
  function activeRow(renderer: ReactTestRenderer): string | undefined {
    return renderer.root
      .findAllByType("button")
      .filter((b) => b.props["aria-selected"] === true)
      .map((b) => b.props.children as string)[0]
  }

  async function noteComposer(onNote = vi.fn().mockResolvedValue(true)) {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("conversation-a", vi.fn())} channel="SMS" availableChannels={[]} onNote={onNote} />)
    })
    return renderer
  }

  async function type(renderer: ReactTestRenderer, value: string, selectionStart?: number) {
    await act(async () => {
      textarea(renderer).props.onChange({
        target: selectionStart === undefined ? { value } : { value, selectionStart },
      })
    })
  }

  // Returns the preventDefault spy: whether the key was consumed is part of the
  // behaviour (Enter must not also insert a newline in the note).
  async function keyDown(renderer: ReactTestRenderer, key: string, modifiers: Record<string, boolean> = {}) {
    const preventDefault = vi.fn()
    await act(async () => {
      textarea(renderer).props.onKeyDown({ key, preventDefault, ...modifiers })
    })
    return preventDefault
  }

  it("starts on the first row and moves the active row with ArrowDown", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@")
    expect(pickerRows(renderer)).toEqual(["Bo Nkosi", "Cy Dlamini"])
    expect(activeRow(renderer)).toBe("Bo Nkosi")

    const prevented = await keyDown(renderer, "ArrowDown")

    expect(activeRow(renderer)).toBe("Cy Dlamini")
    expect(prevented).toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  // Exactly two presses on a two-row list: a third would land back on the last
  // row under wrapping too, and the test would pass either way.
  it("clamps at the last row rather than wrapping to the first", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@")

    await keyDown(renderer, "ArrowDown")
    await keyDown(renderer, "ArrowDown")

    expect(activeRow(renderer)).toBe("Cy Dlamini")
    await act(async () => renderer.unmount())
  })

  it("clamps at the first row rather than wrapping to the last", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@")

    await keyDown(renderer, "ArrowUp")
    expect(activeRow(renderer)).toBe("Bo Nkosi")

    await keyDown(renderer, "ArrowDown")
    await keyDown(renderer, "ArrowUp")
    expect(activeRow(renderer)).toBe("Bo Nkosi")
    await act(async () => renderer.unmount())
  })

  // The whole point of the finding: a pick made from the keyboard has to land in
  // draft.mentions, or nobody is notified.
  it("Enter picks the active row and pings that id on submit", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)
    await type(renderer, "please chase @")
    await keyDown(renderer, "ArrowDown")

    const prevented = await keyDown(renderer, "Enter")

    expect(textarea(renderer).props.value).toBe("please chase @Cy Dlamini ")
    expect(prevented).toHaveBeenCalled()
    // Selecting is not submitting: the note is still in the composer.
    expect(onNote).not.toHaveBeenCalled()
    expect(pickerRows(renderer)).toEqual([])

    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(onNote).toHaveBeenCalledWith("conversation-a", "please chase @Cy Dlamini", ["u3"])
    await act(async () => renderer.unmount())
  })

  // The new run has to still match BOTH rows: if the list shrank to one row the
  // picker's own clamp would paint row 0 regardless, and a stale index would be
  // invisible here while still selecting the wrong person on a longer roster.
  it("resets the active row to the first when the run changes", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@")
    await keyDown(renderer, "ArrowDown")
    expect(activeRow(renderer)).toBe("Cy Dlamini")

    await type(renderer, "x @")

    expect(pickerRows(renderer)).toEqual(["Bo Nkosi", "Cy Dlamini"])
    expect(activeRow(renderer)).toBe("Bo Nkosi")
    await act(async () => renderer.unmount())
  })

  // The composer keeps its own filtered copy to drive Enter. If only the picker
  // excluded the author, the visible rows would be right while Enter tagged the
  // person one row up.
  it("Enter picks from the same list the picker shows when the author is excluded", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer {...props("conversation-a", vi.fn())} channel="SMS" availableChannels={[]} onNote={onNote} currentUserId="u2" />,
      )
    })
    await type(renderer, "@")
    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])

    await keyDown(renderer, "Enter")

    expect(textarea(renderer).props.value).toBe("@Cy Dlamini ")
    await act(async () => { await noteButton(renderer).props.onClick() })
    expect(onNote).toHaveBeenCalledWith("conversation-a", "@Cy Dlamini", ["u3"])
    await act(async () => renderer.unmount())
  })

  it("Escape closes the picker without touching the text, and a later @ reopens it", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@bo")
    expect(pickerRows(renderer)).toEqual(["Bo Nkosi"])

    const prevented = await keyDown(renderer, "Escape")

    expect(pickerRows(renderer)).toEqual([])
    expect(textarea(renderer).props.value).toBe("@bo")
    expect(prevented).toHaveBeenCalled()

    // Still editing the dismissed run: Escape is scoped to that run, so it stays shut.
    await type(renderer, "@bon")
    expect(pickerRows(renderer)).toEqual([])

    // A new run reopens it.
    await type(renderer, "@bon @c")
    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])
    await act(async () => renderer.unmount())
  })

  // Escape used to be gated behind an active MATCH, so it did nothing while a
  // non-matching query was open. Invisible at the time (no picker renders for
  // an empty match list) but wrong: the run is still open, and deleting back to
  // a matching query then popped a picker the agent had already dismissed.
  it("Escape dismisses a run that matches nobody, so editing it back does not reopen the picker", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@zzz")
    expect(pickerRows(renderer)).toEqual([])

    const prevented = await keyDown(renderer, "Escape")
    expect(prevented).toHaveBeenCalled()

    // Same run, now matching — it must stay shut because it was dismissed.
    await type(renderer, "@bo")
    expect(pickerRows(renderer)).toEqual([])

    // And a genuinely new run still opens one.
    await type(renderer, "@bo @c")
    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])
    await act(async () => renderer.unmount())
  })

  it("does not fire a keyboard pick after Escape closed the picker", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@bo")
    await keyDown(renderer, "Escape")

    const prevented = await keyDown(renderer, "Enter")

    expect(textarea(renderer).props.value).toBe("@bo")
    expect(prevented).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  // The existing submit keystroke. It sends real customer messages on the reply
  // path, so an open picker must not swallow it.
  it("keeps Cmd+Enter submitting while the picker is open", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)
    await type(renderer, "@cy")
    expect(pickerRows(renderer)).toEqual(["Cy Dlamini"])

    await keyDown(renderer, "Enter", { metaKey: true })

    expect(onNote).toHaveBeenCalledWith("conversation-a", "@cy", [])
    await act(async () => renderer.unmount())
  })

  it("keeps Ctrl+Enter submitting while the picker is open", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)
    await type(renderer, "@cy")

    await keyDown(renderer, "Enter", { ctrlKey: true })

    expect(onNote).toHaveBeenCalledWith("conversation-a", "@cy", [])
    await act(async () => renderer.unmount())
  })

  // With no picker open, Enter is still just a newline — it must not submit, and
  // must not be consumed.
  it("leaves a plain Enter alone when no picker is open", async () => {
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await noteComposer(onNote)
    await type(renderer, "client says he'll pay Friday")

    const prevented = await keyDown(renderer, "Enter")

    expect(onNote).not.toHaveBeenCalled()
    expect(prevented).not.toHaveBeenCalled()
    expect(textarea(renderer).props.value).toBe("client says he'll pay Friday")
    await act(async () => renderer.unmount())
  })

  // An open run that matches nobody has no row to select, so the keys must fall
  // through to the textarea rather than be eaten.
  it("leaves the keys alone when the open query matches nobody", async () => {
    const renderer = await noteComposer()
    await type(renderer, "@zzz")
    expect(pickerRows(renderer)).toEqual([])

    const prevented = await keyDown(renderer, "ArrowDown")

    expect(prevented).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it("never opens keyboard selection in reply mode", async () => {
    const renderer = (await (async () => {
      let r!: ReactTestRenderer
      await act(async () => {
        // WHATSAPP: replyEnabled, noteMode defaults to false, so no mention run.
        r = create(<Composer {...props("conversation-a", vi.fn())} onNote={vi.fn()} />)
      })
      return r
    })())
    await type(renderer, "mail us at @cy")

    const prevented = await keyDown(renderer, "Enter")

    expect(prevented).not.toHaveBeenCalled()
    expect(textarea(renderer).props.value).toBe("mail us at @cy")
    await act(async () => renderer.unmount())
  })
})

function channelButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((b) => b.props["data-channel"] === label)!
}

describe("Composer channel picker", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "operation-1") })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("shows only channels the contact has identities for", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer {...props("cv1", vi.fn())} availableChannels={["EMAIL"]} defaultChannel="EMAIL" />,
      )
    })
    expect(channelButton(renderer, "EMAIL")).toBeDefined()
    expect(renderer.root.findAllByType("button").find((b) => b.props["data-channel"] === "WHATSAPP")).toBeUndefined()
  })

  it("preselects the last inbound channel and sends on it", async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer {...props("cv1", onSend)} availableChannels={["WHATSAPP", "EMAIL"]} defaultChannel="EMAIL" />,
      )
    })
    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "hello" } })
      await sendButton(renderer).props.onClick()
    })
    expect(onSend).toHaveBeenCalledWith("cv1", "hello", "operation-1", "EMAIL")
  })

  it("sends on the channel the agent picks", async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer {...props("cv1", onSend)} availableChannels={["WHATSAPP", "EMAIL"]} defaultChannel="WHATSAPP" />,
      )
    })
    await act(async () => { channelButton(renderer, "EMAIL").props.onClick() })
    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "hello" } })
      await sendButton(renderer).props.onClick()
    })
    expect(onSend).toHaveBeenCalledWith("cv1", "hello", "operation-1", "EMAIL")
  })

  it("disables WhatsApp and preselects EMAIL when the window is closed", async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer
          {...props("cv1", onSend)}
          windowOpen={false}
          availableChannels={["WHATSAPP", "EMAIL"]}
          defaultChannel="WHATSAPP"
        />,
      )
    })
    const wa = channelButton(renderer, "WHATSAPP")
    expect(wa.props.disabled).toBe(true)
    expect(JSON.stringify(wa.props.children)).toContain("window closed — template only")

    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "hello" } })
      await sendButton(renderer).props.onClick()
    })
    expect(onSend).toHaveBeenCalledWith("cv1", "hello", "operation-1", "EMAIL")
  })

  it("shows the SAST free-reply deadline while the window is open", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer
          {...props("cv1", vi.fn())}
          windowOpen
          expiresAt="2026-08-27T14:30:00.000Z"
          availableChannels={["WHATSAPP", "EMAIL"]}
          defaultChannel="WHATSAPP"
        />,
      )
    })
    // 14:30 UTC is 16:30 in Africa/Johannesburg.
    expect(JSON.stringify(renderer.toJSON())).toContain("WhatsApp: free reply until 16:30")
  })

  // The picker already marks WhatsApp blocked outside the window,
  // but when it's the ONLY available channel the Send button was still live —
  // the server rejects with OUTSIDE_WINDOW, but the UI should never let the
  // agent attempt a send it already knows will fail.
  it("disables Send when the only reply channel is an out-of-window WhatsApp", async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer
          {...props("cv1", onSend)}
          windowOpen={false}
          availableChannels={["WHATSAPP"]}
          defaultChannel="WHATSAPP"
        />,
      )
    })
    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "hello" } })
    })
    expect(sendButton(renderer).props.disabled).toBe(true)

    await act(async () => { await sendButton(renderer).props.onClick() })

    expect(onSend).not.toHaveBeenCalled()
  })
})

describe("Composer website chat (CHATBOT) threads", () => {
  beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(() => { delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

  function dataChannelButtons(renderer: ReactTestRenderer) {
    return renderer.root.findAll((n) => n.props["data-channel"] !== undefined)
  }

  it("is read-only with a phone-follow-up notice, and still takes notes", () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <Composer
          {...props("cv1", vi.fn())}
          channel="CHATBOT" availableChannels={[]} defaultChannel="CHATBOT"
          onNote={vi.fn()}
        />,
      )
    })
    const text = bannerText(renderer)
    expect(text).toContain("Website chat")
    expect(text.toLowerCase()).toContain("phone")
    expect(text).not.toContain("channel-of-record")
    expect(dataChannelButtons(renderer)).toHaveLength(0)
    expect(renderer.root.findAllByType("textarea").length).toBeGreaterThan(0)
    act(() => renderer.unmount())
  })

  it("offers no reply channel even when the contact has an email address", () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <Composer
          {...props("cv1", vi.fn())}
          channel="CHATBOT" availableChannels={["EMAIL"]} defaultChannel="CHATBOT"
          onNote={vi.fn()}
        />,
      )
    })
    expect(dataChannelButtons(renderer)).toHaveLength(0)
    expect(bannerText(renderer)).not.toContain("channel-of-record")
    act(() => renderer.unmount())
  })
})

describe("Composer website chat takeover", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "operation-1") })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  type Takeover = { assigneeId: string | null; assigneeName: string | null; closed: boolean }
  const JOINED: Takeover = { assigneeId: "u1", assigneeName: "Ana Dube", closed: false }

  async function chat(
    takeover: Takeover,
    handlers: {
      onSend?: (conversationId: string, text: string, operationId: string, channel: string) => Promise<boolean>
      onNote?: (conversationId: string, text: string, mentionUserIds: string[]) => Promise<boolean>
      fallback?: { reason: string; detail?: string }
    } = {},
  ) {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer
          {...props("cv1", handlers.onSend ?? vi.fn())}
          // A stray address on the chat contact must not turn into a channel
          // picker, and no WhatsApp default or closed 24h window may reach a
          // chat reply: the conversation's own channel decides, nothing else.
          channel="CHATBOT" availableChannels={["EMAIL"]} defaultChannel="WHATSAPP" windowOpen={false}
          currentUserId="u1"
          chatTakeover={takeover}
          onNote={handlers.onNote ?? vi.fn()}
          fallback={handlers.fallback ?? null}
        />,
      )
    })
    return renderer
  }

  function replyToggle(renderer: ReactTestRenderer) {
    return renderer.root.findAllByType("button").find((button) => button.props.children === "Reply")!
  }

  it("sends the joined staffer's reply on the CHATBOT channel", async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const renderer = await chat(JOINED, { onSend })

    expect(textarea(renderer).props.placeholder).toBe("Reply to the visitor in the website chat…")
    expect(textarea(renderer).props.maxLength).toBe(2000)
    expect(renderer.root.findAll((n) => n.props["data-channel"] !== undefined)).toHaveLength(0)
    expect(bannerText(renderer)).not.toContain("window")

    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "Hello there" } })
    })
    await act(async () => { await sendButton(renderer).props.onClick() })

    expect(onSend).toHaveBeenCalledWith("cv1", "Hello there", "operation-1", "CHATBOT")
    await act(async () => renderer.unmount())
  })

  // The client comms tab passes no takeover state and has no join button, so a
  // chat there must stay as it was: notes only.
  it("stays read-only on a surface that passes no takeover state", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <Composer {...props("cv1", vi.fn())} channel="CHATBOT" availableChannels={[]} defaultChannel="CHATBOT" currentUserId="u1" onNote={vi.fn()} />,
      )
    })
    expect(replyToggle(renderer).props.disabled).toBe(true)
    expect(sendButton(renderer)).toBeUndefined()
    await act(async () => renderer.unmount())
  })

  it("does not cap an internal note at the visitor reply length", async () => {
    const renderer = await chat(JOINED)
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Internal note")!.props.onClick()
    })
    expect(textarea(renderer).props.maxLength).toBeUndefined()
    await act(async () => renderer.unmount())
  })

  it.each<[string, Takeover, string]>([
    ["nobody has joined", { assigneeId: null, assigneeName: null, closed: false }, "Join the chat to reply to the visitor."],
    ["a colleague holds it", { assigneeId: "u2", assigneeName: "Bo Nkosi", closed: false }, "Taken by Bo Nkosi."],
    ["an unnamed colleague holds it", { assigneeId: "u2", assigneeName: null, closed: false }, "Taken by a colleague."],
    ["it has ended", { assigneeId: "u1", assigneeName: "Ana Dube", closed: true }, "This chat has ended."],
  ])("takes notes only when %s, and says why", async (_label, takeover, line) => {
    const onSend = vi.fn()
    const onNote = vi.fn().mockResolvedValue(true)
    const renderer = await chat(takeover, { onSend, onNote })

    expect(bannerText(renderer)).toContain(line)
    expect(replyToggle(renderer).props.disabled).toBe(true)
    expect(sendButton(renderer)).toBeUndefined()

    await act(async () => {
      textarea(renderer).props.onChange({ target: { value: "phoned, no answer" } })
    })
    await act(async () => { await noteButton(renderer).props.onClick() })

    expect(onNote).toHaveBeenCalledWith("cv1", "phoned, no answer", [])
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it("shows the server's own reason for a refused reply, without channel-of-record advice", async () => {
    const renderer = await chat(JOINED, {
      fallback: { reason: "SEND_FAILED", detail: "Replies are limited to 2000 characters." },
    })
    const text = bannerText(renderer)
    expect(text).toContain("Replies are limited to 2000 characters.")
    expect(text).not.toContain("Message could not be sent right now.")
    expect(text).not.toContain("channel-of-record")
    await act(async () => renderer.unmount())
  })
})

describe("Composer canned replies", () => {
  beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(() => { delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

  const CANNED = [{ id: "c1", title: "Balance", body: "Your account balance is on your statement." }]
  const pickers = (renderer: ReactTestRenderer) => renderer.root.findAllByType("select")
  const noteToggle = (renderer: ReactTestRenderer) => renderer.root.findAllByType("button").find((b) => b.props.children === "Internal note")!

  async function composer(extra: Partial<Parameters<typeof Composer>[0]> = {}) {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<Composer {...props("cv1", vi.fn())} cannedReplies={CANNED} currentUserId="u1" onNote={vi.fn()} {...extra} />)
    })
    return renderer
  }

  it("offers them on a customer thread's reply, appends the chosen one to the draft, and not on a note", async () => {
    const renderer = await composer()
    expect(pickers(renderer)).toHaveLength(1)
    expect(pickers(renderer)[0].findAllByType("option").map((o) => o.props.children)).toEqual(["Insert canned reply…", "Balance"])

    await act(async () => { pickers(renderer)[0].props.onChange({ target: { value: "c1" } }) })
    expect(textarea(renderer).props.value).toBe(CANNED[0].body)
    await act(async () => { pickers(renderer)[0].props.onChange({ target: { value: "c1" } }) })
    expect(textarea(renderer).props.value).toBe(`${CANNED[0].body}\n${CANNED[0].body}`)

    await act(async () => { noteToggle(renderer).props.onClick() })
    expect(pickers(renderer)).toHaveLength(0)
    await act(async () => renderer.unmount())
  })

  // Canned replies are written for verified customers and may mention accounts;
  // a website visitor is unverified.
  it("offers none on a website chat, in the joined staffer's reply or in a note", async () => {
    const renderer = await composer({
      channel: "CHATBOT", availableChannels: [], defaultChannel: "CHATBOT",
      chatTakeover: { assigneeId: "u1", assigneeName: "Ana Dube", closed: false },
    })
    expect(sendButton(renderer)).toBeDefined() // reply mode: the visitor can be answered
    expect(pickers(renderer)).toHaveLength(0)

    await act(async () => { noteToggle(renderer).props.onClick() })
    expect(pickers(renderer)).toHaveLength(0)
    await act(async () => renderer.unmount())
  })
})
