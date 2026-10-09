import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChatLine } from "@/lib/website-chat/mode"
import { useWebsiteChat, whatsAppFallbackText } from "./useWebsiteChat"
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

type Reply = { status: number; body: unknown; retryAfter?: string }
type Route = "start" | "message" | "poll"

const jsonResponse = ({ status, body, retryAfter }: Reply) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: () => retryAfter ?? null }, json: async () => body })

const GREETING: ChatLine = { id: "m1", from: "assistant", text: "Hi Thabo, welcome." }
const FORM = { name: "Thabo Mokoena", phone: "0821234567", email: "thabo@example.com", consent: true }

const pollBody = (mode: string, lines: ChatLine[] = [GREETING], staffName: string | null = null) =>
  ({ status: 200, body: { mode, staffName, ref: "WC-ABC234", lines } })

describe("useWebsiteChat", () => {
  let renderer!: ReactTestRenderer
  let chat!: ReturnType<typeof useWebsiteChat>
  let fetchMock: ReturnType<typeof vi.fn>
  // One answer per route, so a second fetch can never be served by another route's stub.
  let answers: Record<Route, () => Promise<Reply> | Reply>
  // The tab, as the hook sees it: `hidden`, and whoever listens for it changing.
  let tab: { hidden: boolean; listeners: Set<() => void> }

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

  it("refuses to start without a challenge token", async () => {
    let outcome = ""
    await act(async () => { outcome = await chat.start(FORM, null) })
    expect(outcome).toBe("invalid")
    expect(chat.errors).toEqual({ submit: "Please complete the verification challenge." })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not poll before the chat starts, then polls every 15s while the assistant answers", async () => {
    await tick(60_000)
    expect(polls()).toBe(0)
    await start()
    expect(chat.ref).toBe("WC-ABC234")
    expect(shown()).toEqual(["assistant:Hi Thabo, welcome."])
    await tick(14_999)
    expect(polls()).toBe(0)
    await tick(1)
    expect(polls()).toBe(1)
    await tick(15_000)
    expect(polls()).toBe(2)
  })

  it("polls every 3s while waiting or with staff, and every 15s again in fallback", async () => {
    await start()
    answers.poll = () => pollBody("waiting")
    await tick(15_000)
    expect(chat.mode).toBe("waiting")
    await tick(3_000)
    expect(polls()).toBe(2)
    answers.poll = () => pollBody("staff", [GREETING], "Lerato")
    await tick(3_000)
    expect(polls()).toBe(3)
    expect(chat.staffName).toBe("Lerato")
    answers.poll = () => pollBody("fallback")
    await tick(3_000)
    expect(polls()).toBe(4)
    await tick(14_999)
    expect(polls()).toBe(4)
    await tick(1)
    expect(polls()).toBe(5)
  })

  it("stops polling once the chat has ended", async () => {
    await start()
    answers.poll = () => pollBody("ended")
    await tick(15_000)
    expect(chat.mode).toBe("ended")
    expect(chat.notice).toBe("This chat has ended.")
    expect(vi.getTimerCount()).toBe(0)
    await tick(120_000)
    expect(polls()).toBe(1)
  })

  it("drops a queued poll when the one in flight reports the chat ended", async () => {
    await start()
    const release = holdPoll()
    await tick(15_000)
    await send("Hello?")
    answers.poll = () => pollBody("bot")
    await release(pollBody("ended"))
    await tick(120_000)
    expect(polls()).toBe(1)
    expect(chat.mode).toBe("ended")
  })

  it("stops polling when the panel unmounts", async () => {
    await start()
    await tick(15_000)
    await act(async () => renderer.unmount())
    expect(vi.getTimerCount()).toBe(0)
    await tick(120_000)
    expect(polls()).toBe(1)
    await mount()
  })

  it("books nothing when a poll in flight answers after the panel unmounted", async () => {
    await start()
    const release = holdPoll()
    await tick(15_000)
    await act(async () => renderer.unmount())
    await release(pollBody("waiting"))
    expect(vi.getTimerCount()).toBe(0)
    await mount()
  })

  it("swallows a failed poll and retries on the next tick", async () => {
    await start()
    answers.poll = () => { throw new Error("offline") }
    await tick(15_000)
    answers.poll = () => ({ status: 500, body: { error: "Something went wrong. Please WhatsApp or call us." } })
    await tick(15_000)
    expect(chat.notice).toBeNull()
    answers.poll = () => pollBody("waiting")
    await tick(15_000)
    expect(polls()).toBe(3)
    expect(chat.mode).toBe("waiting")
  })

  it.each([
    [401, "This chat session has expired. Please start a new chat."],
    [404, "The chat is not available right now. Please WhatsApp or call us."],
  ])("ends the chat with the server's text on a %i poll", async (status, error) => {
    await start()
    answers.poll = () => ({ status, body: { error } })
    await tick(15_000)
    expect(chat.phase).toBe("ended")
    expect(chat.notice).toBe(error)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("waits out Retry-After on a 429 poll and keeps the timer running", async () => {
    await start()
    answers.poll = () => pollBody("waiting")
    await tick(15_000)
    answers.poll = () => ({ status: 429, body: { error: "Please wait a moment." }, retryAfter: "20" })
    await tick(3_000)
    expect(polls()).toBe(2)
    expect(chat.notice).toBeNull()
    answers.poll = () => pollBody("waiting")
    await tick(19_999)
    expect(polls()).toBe(2)
    await tick(1)
    expect(polls()).toBe(3)
  })

  it("shows the visitor's message and the reply at once, then takes the poll's lines without duplicates", async () => {
    await start()
    const release = holdPoll()
    await send("Are you registered?")
    expect(shown()).toEqual(["assistant:Hi Thabo, welcome.", "visitor:Are you registered?", "assistant:We are NCR registered."])
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body)).toEqual({ token: "sess", text: "Are you registered?" })
    // The send triggered one poll straight away, and that poll replaced the booked 15s one.
    await tick(15_000)
    expect(polls()).toBe(1)
    const lines: ChatLine[] = [
      GREETING,
      { id: "m2", from: "visitor", text: "Are you registered?" },
      { id: "m3", from: "assistant", text: "We are NCR registered." },
    ]
    await release(pollBody("bot", lines))
    expect(chat.lines).toEqual(lines)
    expect(polls()).toBe(1)
  })

  it("keeps every optimistic message the poll has not reached, in order", async () => {
    await start()
    const release = holdPoll()
    await send("One")
    await send("Two")
    const caughtUp: ChatLine[] = [GREETING, { id: "m2", from: "visitor", text: "One" }, { id: "m3", from: "assistant", text: "We are NCR registered." }]
    await release(pollBody("bot", caughtUp))
    await release(pollBody("bot", caughtUp)) // the queued poll: the same transcript must not match "Two" as well
    expect(chat.lines.slice(0, 3)).toEqual(caughtUp)
    expect(shown().slice(3)).toEqual(["visitor:Two", "assistant:We are NCR registered."])
  })

  it("forgets a refused message at the next send, so it is never matched against the transcript", async () => {
    await start()
    answers.message = () => ({ status: 429, body: { error: "You're sending messages too quickly. Please wait a moment." } })
    await send("Refused")
    expect(shown()).toContain("visitor:Refused")
    answers.message = () => ({ status: 200, body: { mode: "waiting", staffName: null } })
    const release = holdPoll()
    await send("Stored")
    expect(shown()).toEqual(["assistant:Hi Thabo, welcome.", "visitor:Stored"])
    await release(pollBody("waiting", [GREETING, { id: "m2", from: "visitor", text: "Stored" }]))
    expect(shown()).toEqual(["assistant:Hi Thabo, welcome.", "visitor:Stored"])
  })

  it("keeps an optimistic message a poll has not caught up with, and never overlaps polls", async () => {
    await start()
    let answer!: (r: Reply) => void
    answers.message = () => new Promise<Reply>((resolve) => { answer = resolve })
    let sending!: Promise<void>
    await act(async () => { sending = chat.send("Hello?") })
    // The timer poll lands mid-send, read before the server stored the message.
    const release = holdPoll()
    await tick(15_000)
    expect(polls()).toBe(1)
    await act(async () => { answer({ status: 200, body: { mode: "staff", staffName: "Lerato" } }); await sending })
    expect(chat.mode).toBe("staff")
    expect(chat.staffName).toBe("Lerato")
    // The send wants a poll, but one is still in flight: it queues instead of overlapping.
    expect(polls()).toBe(1)
    answers.poll = () => pollBody("staff", [GREETING, { id: "m2", from: "visitor", text: "Hello?" }], "Lerato")
    await release(pollBody("bot"))
    await tick(0)
    expect(polls()).toBe(2)
    expect(shown()).toEqual(["assistant:Hi Thabo, welcome.", "visitor:Hello?"])
    expect(chat.lines[1].id).toBe("m2")
    await tick(3_000)
    expect(polls()).toBe(3)
  })

})

describe("whatsAppFallbackText", () => {
  const visitor = (text: string): ChatLine => ({ id: text, from: "visitor", text })

  it("omits the question when the visitor has not written, and the bracket when there is no ref", () => {
    expect(whatsAppFallbackText("WC-ABC234", [GREETING])).toBe("Hi, I was chatting on your website (ref WC-ABC234).")
    expect(whatsAppFallbackText(null, [visitor("first"), visitor("Hello"), GREETING])).toBe("Hi, I was chatting on your website. Hello")
  })
})
