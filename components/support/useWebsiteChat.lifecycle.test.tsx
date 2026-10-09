// Split from useWebsiteChat.test.tsx (300-line limit): a hidden tab, and what ends a chat and what does not.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChatLine } from "@/lib/website-chat/mode"
import { useWebsiteChat } from "./useWebsiteChat"
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

type Reply = { status: number; body: unknown; retryAfter?: string }
type Route = "start" | "message" | "poll"

const jsonResponse = ({ status, body, retryAfter }: Reply) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: () => retryAfter ?? null }, json: async () => body })

const GREETING: ChatLine = { id: "m1", from: "assistant", text: "Hi Thabo, welcome." }
const FORM = { name: "Thabo Mokoena", phone: "0821234567", email: "thabo@example.com", consent: true }

const pollBody = (mode: string, lines: ChatLine[] = [GREETING], staffName: string | null = null) =>
  ({ status: 200, body: { mode, staffName, ref: "WC-ABC234", lines } })

describe("useWebsiteChat: when it polls and when a chat ends", () => {
  let renderer!: ReactTestRenderer
  let chat!: ReturnType<typeof useWebsiteChat>
  let fetchMock: ReturnType<typeof vi.fn>
  // One answer per route, so a second fetch can never be served by another route's stub.
  let answers: Record<Route, () => Promise<Reply> | Reply>
  // The tab, as the hook sees it: `hidden`, and whoever listens for it changing.
  let tab: { hidden: boolean; listeners: Set<() => void> }
  const setHidden = (hidden: boolean) => act(async () => { tab.hidden = hidden; for (const fn of tab.listeners) fn() })

  function Harness() {
    const value = useWebsiteChat()
    useEffect(() => { chat = value })
    return null
  }

  const mount = () => act(async () => { renderer = create(<Harness />) })
  const polls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/website/chat/poll").length
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  const shown = () => chat.lines.map((l) => `${l.from}:${l.text}`)

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    answers = {
      start: () => ({ status: 200, body: { token: "sess", greeting: GREETING.text, ref: "WC-ABC234" } }),
      message: () => ({ status: 200, body: { reply: "We are NCR registered.", handedOff: false, mode: "bot" } }),
      poll: () => pollBody("bot"),
    }
    fetchMock = vi.fn(async (url: string) => {
      const route = url.replace("/api/website/chat/", "") as Route
      if (!answers[route]) throw new Error(`unexpected fetch ${url}`)
      return jsonResponse(await answers[route]())
    })
    vi.stubGlobal("fetch", fetchMock)
    tab = { hidden: false, listeners: new Set() }
    vi.stubGlobal("document", {
      get hidden() { return tab.hidden },
      addEventListener: (type: string, fn: () => void) => { if (type === "visibilitychange") tab.listeners.add(fn) },
      removeEventListener: (_type: string, fn: () => void) => { tab.listeners.delete(fn) },
    })
    await mount()
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  /** Holds the next poll open until the returned function answers it. */
  function holdPoll() {
    let resolvePoll!: (r: Reply) => void
    answers.poll = () => new Promise<Reply>((resolve) => { resolvePoll = resolve })
    return (reply: Reply) => act(async () => { resolvePoll(reply) })
  }

  const start = () => act(async () => { await chat.start(FORM, "tok") })
  const send = (text: string) => act(async () => { await chat.send(text) })

  it("a hidden tab does not poll; coming back polls at once and the timer resumes", async () => {
    await start()
    answers.poll = () => pollBody("waiting")
    await tick(15_000)
    expect(polls()).toBe(1)
    await setHidden(true)
    await tick(10 * 60_000)
    expect(polls()).toBe(1)

    answers.poll = () => pollBody("staff", [GREETING], "Lerato")
    await setHidden(false)
    expect(polls()).toBe(2)
    expect(chat.mode).toBe("staff")
    await tick(3_000)
    expect(polls()).toBe(3)
  })

  it("a poll in flight when the tab is hidden books no next one", async () => {
    await start()
    const answer = holdPoll()
    await tick(15_000)
    await setHidden(true)
    await answer(pollBody("waiting"))
    answers.poll = () => pollBody("waiting")
    await tick(60_000)
    expect(polls()).toBe(1)
  })

  it("showing the tab before the chat has started, or after it ended, polls nothing; the listener goes with the widget", async () => {
    await setHidden(true)
    await setHidden(false)
    expect(polls()).toBe(0)
    await start()
    answers.poll = () => pollBody("ended")
    await tick(15_000)
    expect(chat.phase).toBe("ended")
    await setHidden(true)
    await setHidden(false)
    expect(polls()).toBe(1)
    expect(tab.listeners.size).toBe(1)
    await act(async () => renderer.unmount())
    expect(tab.listeners.size).toBe(0)
    await mount()
  })

  it("a per-chat cap hand-off (429 with handedOff) is a hand-off, not an end: the input stays, the mode is the server's, polling goes on", async () => {
    await start()
    answers.message = () => ({ status: 429, body: { reply: "I can't help with that here, so I'll connect you to a consultant.", handedOff: true, mode: "waiting" } })
    answers.poll = () => pollBody("waiting")
    await send("one more question")
    expect(chat.phase).toBe("chat")
    expect(chat.mode).toBe("waiting")
    expect(shown()).toContain("assistant:I can't help with that here, so I'll connect you to a consultant.")
    expect(chat.notice).toBeNull()
    await tick(3_000)
    expect(polls()).toBe(1)

    // A consultant joins: the visitor sees them and can write to them.
    answers.poll = () => pollBody("staff", [GREETING, { id: "s1", from: "staff", text: "Hi, Thandi here. How can I help?", name: "Thandi" }], "Thandi")
    await tick(3_000)
    expect({ phase: chat.phase, mode: chat.mode, staffName: chat.staffName }).toEqual({ phase: "chat", mode: "staff", staffName: "Thandi" })
    answers.message = () => ({ status: 200, body: { mode: "staff", staffName: "Thandi" } })
    const sent = () => fetchMock.mock.calls.filter(([url]) => url === "/api/website/chat/message").length
    const before = sent()
    await send("Yes, I want to ask about fees")
    expect(sent()).toBe(before + 1)
  })

  it("a chat that ends while a consultant holds it says so and takes the input away", async () => {
    await start()
    answers.poll = () => pollBody("staff", [GREETING], "Thandi")
    await tick(15_000)
    expect(chat.mode).toBe("staff")
    answers.poll = () => pollBody("ended")
    await tick(3_000)
    expect({ phase: chat.phase, mode: chat.mode, notice: chat.notice }).toEqual({ phase: "ended", mode: "ended", notice: "This chat has ended." })
  })

  it("a message answered 404 (the chat was switched off) ends the session with the server's words", async () => {
    await start()
    answers.message = () => ({ status: 404, body: { error: "The chat is not available right now. Please WhatsApp or call us." } })
    await send("hello?")
    expect(chat.phase).toBe("ended")
    expect(chat.notice).toBe("The chat is not available right now. Please WhatsApp or call us.")
  })

  it("only warns on a plain 429, and ends on a 429 that says the chat is over", async () => {
    await start()
    answers.message = () => ({ status: 429, body: { error: "You're sending messages too quickly. Please wait a moment." } })
    await send("hi")
    expect(chat.phase).toBe("chat")
    expect(chat.notice).toBe("You're sending messages too quickly. Please wait a moment.")
    answers.message = () => ({ status: 429, body: { mode: "ended" } })
    await send("hi again")
    expect(chat.phase).toBe("ended")
    expect(chat.notice).toBe("This chat has ended.")
    await tick(120_000)
    expect(polls()).toBe(0)
  })

  it("in the fallback a message kept for staff (no reply) shows only the visitor's own line and no notice", async () => {
    await start()
    answers.poll = () => pollBody("fallback")
    await tick(15_000)
    answers.message = () => ({ status: 200, body: { mode: "fallback", staffName: null } })
    answers.poll = () => pollBody("fallback", [GREETING, { id: "m2", from: "visitor", text: "Please call me" }])
    await send("Please call me")
    expect(shown()).toEqual(["assistant:Hi Thabo, welcome.", "visitor:Please call me"])
    expect({ phase: chat.phase, mode: chat.mode, notice: chat.notice }).toEqual({ phase: "chat", mode: "fallback", notice: null })
  })

  it("past the staff-mode cap: the server's notice, the input kept, and polling goes on so the consultant's replies still arrive", async () => {
    const LIMIT = "You've reached the message limit for this chat. The consultant can still reply."
    await start()
    answers.poll = () => pollBody("staff", [GREETING], "Thandi")
    await tick(15_000)
    answers.message = () => ({ status: 429, body: { mode: "staff", error: LIMIT } })
    await send("one more")
    expect({ phase: chat.phase, mode: chat.mode, notice: chat.notice }).toEqual({ phase: "chat", mode: "staff", notice: LIMIT })
    const before = polls()
    answers.poll = () => pollBody("staff", [GREETING, { id: "s1", from: "staff", text: "I'll call you now.", name: "Thandi" }], "Thandi")
    await tick(3_000)
    expect(polls()).toBe(before + 1)
    expect(shown()).toContain("staff:I'll call you now.")
    await send("thanks")
    expect({ phase: chat.phase, notice: chat.notice }).toEqual({ phase: "chat", notice: LIMIT })
  })
})
