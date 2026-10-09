// Split from useWebsiteChat.test.tsx (300-line limit): a chat that survives a refresh or a page change.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChatLine } from "@/lib/website-chat/mode"
import { useWebsiteChat } from "./useWebsiteChat"
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

type Reply = { status: number; body: unknown }
type Route = "start" | "message" | "poll"

const jsonResponse = ({ status, body }: Reply) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })

const KEY = "cf-website-chat"
const GREETING: ChatLine = { id: "m1", from: "assistant", text: "Hi Thabo, welcome." }
const ASKED: ChatLine = { id: "m2", from: "visitor", text: "Are you registered?" }
const ANSWERED: ChatLine = { id: "m3", from: "assistant", text: "We are NCR registered." }
const FORM = { name: "Thabo Mokoena", phone: "0821234567", email: "thabo@example.com", consent: true }

describe("useWebsiteChat: carrying a chat across a refresh", () => {
  let renderer: ReactTestRenderer | null
  let chat!: ReturnType<typeof useWebsiteChat>
  let fetchMock: ReturnType<typeof vi.fn>
  let answers: Record<Route, () => Reply>
  let store: Map<string, string>

  function Harness() {
    const value = useWebsiteChat()
    useEffect(() => { chat = value })
    return null
  }

  const mount = () => act(async () => { renderer = create(<Harness />) })
  const unmount = () => act(async () => { renderer?.unmount(); renderer = null })
  const calls = (route: Route) => fetchMock.mock.calls.filter(([url]) => url === `/api/website/chat/${route}`).length
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  const shown = () => chat.lines.map((l) => `${l.from}:${l.text}`)
  const start = () => act(async () => { await chat.start(FORM, "tok") })

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    renderer = null
    answers = {
      start: () => ({ status: 200, body: { token: "sess", greeting: GREETING.text, ref: "WC-ABC234" } }),
      message: () => ({ status: 200, body: { reply: ANSWERED.text, handedOff: false, mode: "bot" } }),
      poll: () => ({ status: 200, body: { mode: "bot", staffName: null, ref: "WC-ABC234", lines: [GREETING, ASKED, ANSWERED] } }),
    }
    fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      const route = url.replace("/api/website/chat/", "") as Route
      if (route !== "start" && JSON.parse(init.body).token !== "sess") return jsonResponse({ status: 401, body: { error: "Unknown chat." } })
      return jsonResponse(answers[route]())
    })
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} })
    store = new Map()
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })

  afterEach(async () => {
    await unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("a fresh page with nothing stored shows the form and asks the server nothing", async () => {
    await mount()
    await tick(60_000)
    expect(chat.phase).toBe("form")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("after a refresh, the chat comes back from one immediate poll, with no new start", async () => {
    await mount()
    await start()
    expect(JSON.parse(store.get(KEY) ?? "null")).toEqual({ token: "sess", open: true })
    await unmount()

    await mount()
    expect(chat.phase).toBe("chat")
    expect(calls("start")).toBe(1)
    expect(calls("poll")).toBe(1)
    expect(shown()).toEqual(["assistant:Hi Thabo, welcome.", "visitor:Are you registered?", "assistant:We are NCR registered."])
    expect(chat.ref).toBe("WC-ABC234")
    expect(chat.mode).toBe("bot")
  })

  it("comes back holding the mode and the person the visitor was with", async () => {
    store.set(KEY, JSON.stringify({ token: "sess" }))
    answers.poll = () => ({ status: 200, body: { mode: "staff", staffName: "Lerato", ref: "WC-ABC234", lines: [GREETING] } })
    await mount()
    expect(chat.mode).toBe("staff")
    expect(chat.staffName).toBe("Lerato")
    // Polling carries on at the staff pace.
    await tick(3_000)
    expect(calls("poll")).toBe(2)
  })

  it("a stored chat the server no longer knows (401) is forgotten: the form, nothing stored, no more polls", async () => {
    store.set(KEY, JSON.stringify({ token: "stale" }))
    await mount()
    expect(chat.phase).toBe("form")
    expect(chat.lines).toEqual([])
    expect(store.has(KEY)).toBe(false)
    await tick(60_000)
    expect(calls("poll")).toBe(1)
  })

  it("once restored, a 401 later on is the chat ending, not a stale token: the visitor is told", async () => {
    store.set(KEY, JSON.stringify({ token: "sess" }))
    await mount()
    expect(chat.phase).toBe("chat")
    answers.poll = () => ({ status: 401, body: { error: "This chat has ended." } })
    await tick(15_000)
    expect(chat.phase).toBe("ended")
    expect(chat.notice).toBe("This chat has ended.")
    expect(store.has(KEY)).toBe(false)
  })

  it.each([["{}"], ['{"token":""}'], ['{"token":5}'], ["null"]])("stored %s is no chat: the form, and nothing asked", async (raw) => {
    store.set(KEY, raw)
    await mount()
    expect(chat.phase).toBe("form")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("closing the panel keeps the chat; the chat ending forgets it", async () => {
    await mount()
    await start()
    await unmount()
    expect(store.has(KEY)).toBe(true)

    await mount()
    answers.poll = () => ({ status: 200, body: { mode: "ended", staffName: null, ref: "WC-ABC234", lines: [GREETING] } })
    await tick(15_000)
    expect(chat.phase).toBe("ended")
    expect(store.has(KEY)).toBe(false)
  })

  it.each([401, 404])("a %s on a message mid-chat ends it and forgets it", async (status) => {
    await mount()
    await start()
    answers.message = () => ({ status, body: { error: "This chat has ended." } })
    await act(async () => { await chat.send("hello") })
    expect(chat.phase).toBe("ended")
    expect(store.has(KEY)).toBe(false)
  })

  it("a 404 on a poll mid-chat ends it and forgets it", async () => {
    await mount()
    await start()
    answers.poll = () => ({ status: 404, body: { error: "This chat has ended." } })
    await tick(15_000)
    expect(chat.phase).toBe("ended")
    expect(store.has(KEY)).toBe(false)
  })

  it.each([
    ["every call throws", { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("denied") }, removeItem: () => { throw new Error("denied") } }],
    ["stored data is not JSON", { getItem: () => "{not json", setItem: () => {}, removeItem: () => {} }],
  ])("storage failing (%s) does not stop a chat starting or ending", async (_name, broken) => {
    vi.stubGlobal("sessionStorage", broken)
    await mount()
    expect(chat.phase).toBe("form")
    await start()
    expect(chat.phase).toBe("chat")
    await act(async () => { await chat.send("Are you registered?") })
    expect(shown()).toContain("assistant:We are NCR registered.")
    answers.poll = () => ({ status: 200, body: { mode: "ended", staffName: null, ref: "WC-ABC234", lines: [GREETING] } })
    await tick(15_000)
    expect(chat.phase).toBe("ended")
  })

  it("storage that throws on access at all does not stop a chat starting", async () => {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => { throw new Error("SecurityError") } })
    try {
      await mount()
      await start()
      expect(chat.phase).toBe("chat")
    } finally {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage
    }
  })

  it("End chat clears the stored token, the transcript and the form's state, with no server call; a remount shows the form and polls nothing", async () => {
    await mount()
    await start()
    await act(async () => { await chat.send("Are you registered?") })
    expect(chat.lines.length).toBeGreaterThan(1)
    const before = fetchMock.mock.calls.length
    await act(async () => { chat.endChat() })
    expect(store.has(KEY)).toBe(false)
    expect(chat.phase).toBe("form")
    expect(chat.lines).toEqual([])
    expect(chat.ref).toBeNull()
    await tick(60_000)
    expect(fetchMock.mock.calls.length).toBe(before)

    await unmount()
    await mount()
    expect(chat.phase).toBe("form")
    await tick(60_000)
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it("a poll in flight when the visitor ends the chat does not bring the transcript back", async () => {
    await mount()
    await start()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    answers.poll = () => ({ status: 200, body: { mode: "bot", staffName: null, ref: "WC-ABC234", lines: [GREETING, ASKED] } })
    const original = fetchMock.getMockImplementation() as (url: string, init: { body: string }) => Promise<unknown>
    fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
      if (url.endsWith("/poll")) await gate
      return original(url, init)
    })
    await tick(15_000)
    await act(async () => { chat.endChat() })
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
    expect(chat.phase).toBe("form")
    expect(chat.lines).toEqual([])
  })

  describe("a message in flight when the visitor ends the chat", () => {
    let release!: () => void
    let late: Reply | "offline"; let releaseNext!: () => void

    /** Holds the next message reply until `release()`; a second start gets its own token and greeting. */
    async function sendHeldThenEnd() {
      await mount()
      await start()
      const gate = new Promise<void>((r) => { release = r })
      const original = fetchMock.getMockImplementation() as (url: string, init: { body: string }) => Promise<unknown>
      fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
        if (url.endsWith("/message")) {
          if (JSON.parse(init.body).token === "sess2") {
            await new Promise<void>((r) => { releaseNext = r })
            return jsonResponse({ status: 200, body: { reply: "NEW REPLY", handedOff: false, mode: "bot" } })
          }
          await gate
          if (late === "offline") throw new Error("offline")
          return jsonResponse(late)
        }
        if (url.endsWith("/start") && calls("start") > 1) return jsonResponse({ status: 200, body: { token: "sess2", greeting: "Hi, new chat.", ref: "WC-NEW234" } })
        return original(url, init)
      })
      await act(async () => { void chat.send("Are you registered?"); await Promise.resolve() })
      await act(async () => { chat.endChat() })
    }

    it("its late reply does not appear in the next chat's transcript, and the next chat can send", async () => {
      late = { status: 200, body: { reply: "OLD REPLY", handedOff: false, mode: "bot" } }
      await sendHeldThenEnd()
      await start()
      expect(shown()).toEqual(["assistant:Hi, new chat."])
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
      expect(shown()).toEqual(["assistant:Hi, new chat."])
      expect({ phase: chat.phase, busy: chat.busy, notice: chat.notice, ref: chat.ref }).toEqual({ phase: "chat", busy: false, notice: null, ref: "WC-NEW234" })
    })

    it("its late settling does not release the next chat's own send", async () => {
      late = { status: 200, body: { reply: "OLD REPLY", handedOff: false, mode: "bot" } }
      await sendHeldThenEnd()
      await start()
      await act(async () => { void chat.send("Next question"); await Promise.resolve() })
      expect(chat.busy).toBe(true)
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
      expect(chat.busy).toBe(true)
      await act(async () => { releaseNext(); await vi.advanceTimersByTimeAsync(0) })
      expect(shown()).toEqual(["assistant:Hi, new chat.", "visitor:Next question", "assistant:NEW REPLY"])
      expect(chat.busy).toBe(false)
    })

    it("a late network failure shows no 'could not reach the server' notice on the form", async () => {
      late = "offline"
      await sendHeldThenEnd()
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
      expect({ phase: chat.phase, notice: chat.notice, busy: chat.busy }).toEqual({ phase: "form", notice: null, busy: false })
    })

    it.each([
      ["401", { status: 401, body: { error: "Unknown chat." } }],
      ["409", { status: 409, body: { error: "This chat has ended." } }],
      ["an ended reply", { status: 200, body: { mode: "ended", reply: "OLD REPLY" } }],
    ])("a late %s leaves the form shown, not 'This chat has ended.'", async (_n, reply) => {
      late = reply as Reply
      await sendHeldThenEnd()
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
      expect({ phase: chat.phase, mode: chat.mode, notice: chat.notice, busy: chat.busy }).toEqual({ phase: "form", mode: "bot", notice: null, busy: false })
      expect(chat.lines).toEqual([])
    })
  })
})
