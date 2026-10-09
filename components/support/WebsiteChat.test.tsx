import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { chatConsentText, MAX_CHAT_MESSAGE_CHARS } from "@/lib/website-chat/constants"
import type { ChatLine } from "@/lib/website-chat/mode"

const mounts = { count: 0 }
vi.mock("@/components/turnstile-widget", () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    useEffect(() => {
      mounts.count += 1
      onToken("tok")
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  },
}))

import { WebsiteChat } from "./WebsiteChat"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

type Reply = { status: number; body: unknown }
type Route = "start" | "message" | "poll"
type Line = ChatLine

function jsonResponse({ status, body }: Reply) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body }
}

function text(renderer: ReactTestRenderer): string {
  const walk = (node: unknown): string => {
    if (node === null || node === undefined) return ""
    if (typeof node === "string") return node
    if (Array.isArray(node)) return node.map(walk).join(" ")
    return walk((node as { children?: unknown }).children)
  }
  return walk(renderer.toJSON())
}

function field(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findByProps({ name })
}

async function fillForm(renderer: ReactTestRenderer, consent = true) {
  await act(async () => {
    field(renderer, "name").props.onChange({ target: { value: "Thabo Mokoena" } })
    field(renderer, "phone").props.onChange({ target: { value: "0821234567" } })
    field(renderer, "email").props.onChange({ target: { value: "thabo@example.com" } })
    field(renderer, "consent").props.onChange({ target: { checked: consent } })
  })
}

async function submitForm(renderer: ReactTestRenderer) {
  await act(async () => {
    await renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() })
  })
}

const GREETING: Line = { id: "m1", from: "assistant", text: "Hi Thabo, welcome." }
const AUTOMATED = "Automated assistant. General information only, not advice or a quote."

describe("WebsiteChat", () => {
  let renderer!: ReactTestRenderer
  let fetchMock: ReturnType<typeof vi.fn>
  // One answer per route, so a second fetch can never be served by another route's stub.
  let answers: Record<Route, Reply>

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    mounts.count = 0
    answers = {
      start: { status: 200, body: { token: "sess", greeting: GREETING.text, ref: "WC-ABC234" } },
      message: { status: 200, body: { reply: "We are NCR registered.", handedOff: false, mode: "bot" } },
      poll: { status: 200, body: { mode: "bot", staffName: null, ref: "WC-ABC234", lines: [GREETING] } },
    }
    fetchMock = vi.fn(async (url: string) => {
      const route = url.replace("/api/website/chat/", "") as Route
      if (!answers[route]) throw new Error(`unexpected fetch ${url}`)
      return jsonResponse(answers[route])
    })
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} })
    await act(async () => {
      renderer = create(<WebsiteIdentityProvider identity={ACME_LENDER}><WebsiteChat whatsappE164="+27110000000" onClose={vi.fn()} /></WebsiteIdentityProvider>)
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  async function startChat() {
    await fillForm(renderer)
    await submitForm(renderer)
  }

  /** Start the chat and let the first poll report this state. */
  async function chatIn(mode: string, lines: Line[] = [GREETING], staffName: string | null = null) {
    answers.poll = { status: 200, body: { mode, staffName, ref: "WC-ABC234", lines } }
    await startChat()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  }

  const bodyOf = (route: Route) => {
    const call = fetchMock.mock.calls.find(([url]) => url === `/api/website/chat/${route}`) as [string, { body: string }]
    return JSON.parse(call[1].body)
  }

  it("shows the form, the exact consent text and the automated disclosure", () => {
    expect(field(renderer, "name")).toBeDefined()
    expect(renderer.root.findAllByType("form")).toHaveLength(1)
    const consentLabel = renderer.root.findByProps({ "data-testid": "consent-text" })
    expect(consentLabel.props.children).toBe(chatConsentText("Acme Lending"))
    expect(text(renderer)).toContain("Acme Lending assistant")
    expect(text(renderer)).toContain(AUTOMATED)
  })

  it("does not call fetch and shows an error when consent is unticked", async () => {
    await fillForm(renderer, false)
    await submitForm(renderer)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(text(renderer)).toContain("Please tick the box to continue.")
  })

  it("starts the chat with the turnstile token and shows greeting and a capped textarea", async () => {
    await startChat()
    expect(fetchMock.mock.calls[0][0]).toBe("/api/website/chat/start")
    expect(bodyOf("start")).toEqual({
      name: "Thabo Mokoena",
      phone: "0821234567",
      email: "thabo@example.com",
      consent: true,
      turnstileToken: "tok",
    })
    expect(text(renderer)).toContain("Hi Thabo, welcome.")
    expect(renderer.root.findByType("textarea").props.maxLength).toBe(MAX_CHAT_MESSAGE_CHARS)
  })

  async function sendMessage(value: string) {
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({ target: { value } })
    })
    await act(async () => {
      await renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() })
    })
  }

  it("posts messages, shows the visitor's text in a bubble and the reply, and clears the draft", async () => {
    await startChat()
    await sendMessage("Are you registered?")
    expect(bodyOf("message")).toEqual({ token: "sess", text: "Are you registered?" })
    const out = text(renderer)
    expect(out).toContain("We are NCR registered.")
    expect(out).not.toContain("A consultant will call you")
    const bubble = renderer.root.findByProps({ "data-from": "visitor" })
    expect(bubble.props.children).toBe("Are you registered?")
    expect(bubble.props.className).toMatch(/\bbg-\[/)
    expect(renderer.root.findByType("textarea").props.value).toBe("")
  })

  it("shows the ended notice and removes the input on a 409", async () => {
    await startChat()
    answers.message = { status: 409, body: { error: "This chat has ended. A consultant will be in touch if you asked for a call." } }
    await sendMessage("hello")
    expect(text(renderer)).toContain("This chat has ended. A consultant will be in touch if you asked for a call.")
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0)
  })

  it("keeps the input when a 429 carries handedOff (the per-chat cap hand-off), showing the reply and the server's mode", async () => {
    await startChat()
    answers.message = { status: 429, body: { reply: "A consultant will call you.", handedOff: true, mode: "fallback" } }
    await sendMessage("too many")
    const out = text(renderer)
    expect(out).toContain("A consultant will call you.")
    expect(out).toContain("Continue on WhatsApp")
    expect(renderer.root.findAllByType("textarea")).toHaveLength(1)
  })

  it("a held chat that ends says so, drops the consultant's header and removes the input", async () => {
    await chatIn("staff", [GREETING], "Lerato")
    answers.poll = { status: 200, body: { mode: "ended", staffName: null, ref: "WC-ABC234", lines: [GREETING] } }
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(text(renderer)).toContain("This chat has ended.")
    expect(renderer.root.findByProps({ "data-testid": "chat-title" }).props.children).toBe("Acme Lending assistant")
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0)
  })

  it("keeps the chat open on a plain 429 and shows the notice", async () => {
    await startChat()
    answers.message = { status: 429, body: { error: "You're sending messages too quickly. Please wait a moment." } }
    await sendMessage("hi")
    expect(text(renderer)).toContain("You're sending messages too quickly. Please wait a moment.")
    expect(renderer.root.findAllByType("textarea")).toHaveLength(1)
  })

  it("waiting: says a consultant is being connected and keeps the input enabled", async () => {
    await chatIn("waiting")
    const out = text(renderer)
    expect(out).toContain("Connecting you to a consultant…")
    expect(out).toContain("Acme Lending assistant")
    expect(renderer.root.findAllByType("textarea")).toHaveLength(1)
    expect(renderer.root.findByProps({ children: "Send" }).props.disabled).toBe(false)
  })

  it("staff: names the person in the header, replaces the strapline and labels staff lines", async () => {
    const lines: Line[] = [
      GREETING,
      { id: "m2", from: "staff", name: "Lerato", text: "Lerato from Acme Lending has joined the chat." },
      { id: "m3", from: "staff", name: "Lerato", text: "How can I help?" },
    ]
    await chatIn("staff", lines, "Lerato")
    const out = text(renderer)
    expect(renderer.root.findByProps({ "data-testid": "chat-title" }).props.children).toBe("Lerato from Acme Lending")
    expect(out).toContain("You are chatting to a person.")
    expect(out).not.toContain(AUTOMATED)
    expect(out).not.toContain("Connecting you to a consultant")
    const labels = renderer.root.findAllByProps({ "data-testid": "staff-label" })
    // The join line is a notice (WebsiteChat.format.test.tsx), so only the line Lerato typed is labelled.
    expect(labels.map((l) => l.props.children)).toEqual(["Lerato"])
    const staff = renderer.root.findAllByProps({ "data-from": "staff" })
    const bot = renderer.root.findByProps({ "data-from": "assistant" })
    expect(staff).toHaveLength(2)
    expect(staff[1].props.className).not.toBe(bot.props.className)
    expect(renderer.root.findAllByType("textarea")).toHaveLength(1)
  })

  it("each staff line is labelled with the person who wrote it, not whoever holds the chat now", async () => {
    const lines: Line[] = [
      GREETING,
      { id: "m2", from: "staff", name: "Thandi", text: "Thandi from Acme Lending has joined the chat." },
      { id: "m3", from: "staff", name: "Thandi", text: "Thandi here." },
      { id: "m4", from: "staff", name: "Thandi", text: "Thandi from Acme Lending has left the chat." },
      { id: "m5", from: "staff", name: "Lwazi", text: "Lwazi from Acme Lending has joined the chat." },
      { id: "m6", from: "staff", name: "Lwazi", text: "Lwazi here." },
      { id: "m7", from: "staff", text: "A line with no name" },
    ]
    await chatIn("staff", lines, "Lwazi")
    expect(renderer.root.findByProps({ "data-testid": "chat-title" }).props.children).toBe("Lwazi from Acme Lending")
    expect(renderer.root.findAllByProps({ "data-testid": "staff-label" }).map((l) => l.props.children)).toEqual(["Thandi", "Lwazi", "Consultant"])
  })

  it("ended: removes the input and the WhatsApp link, and shows the notice", async () => {
    await chatIn("ended")
    expect(text(renderer)).toContain("This chat has ended.")
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0)
    expect(renderer.root.findAllByType("a")).toHaveLength(0)
  })

  it("shows a field error next to the phone field on a 400", async () => {
    answers.start = { status: 400, body: { error: "Check the form.", errors: { phone: "Enter a valid cell number." } } }
    await fillForm(renderer)
    await submitForm(renderer)
    const phoneError = renderer.root.findByProps({ id: "chat-phone-error" })
    expect(phoneError.props.children).toBe("Enter a valid cell number.")
    expect(renderer.root.findByProps({ id: "chat-phone" }).props["aria-describedby"]).toBe("chat-phone-error")
    expect(renderer.root.findByProps({ id: "chat-name" }).props["aria-describedby"]).toBeUndefined()
  })

  it("links the consent checkbox to its error", async () => {
    await fillForm(renderer, false)
    await submitForm(renderer)
    expect(renderer.root.findByProps({ id: "chat-consent-error" }).props.children).toBe("Please tick the box to continue.")
    expect(renderer.root.findByProps({ name: "consent" }).props["aria-describedby"]).toBe("chat-consent-error")
  })

  it("remounts the turnstile widget after a failed start, since tokens are single-use", async () => {
    expect(mounts.count).toBe(1)
    answers.start = { status: 400, body: { error: "Check the form." } }
    await fillForm(renderer)
    await submitForm(renderer)
    expect(mounts.count).toBe(2)

    answers.start = { status: 200, body: { token: "sess", greeting: "Hi.", ref: "WC-ABC234" } }
    await submitForm(renderer)
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body).turnstileToken).toBe("tok")
  })

  it("End chat sits in the panel and returns the widget to the form, with no server call", async () => {
    expect(renderer.root.findAllByProps({ "aria-label": "End chat" })).toHaveLength(0)
    await chatIn("bot")
    const calls = fetchMock.mock.calls.length
    await act(async () => { renderer.root.findByProps({ "aria-label": "End chat" }).props.onClick() })
    expect(renderer.root.findAllByType("form")).toHaveLength(1)
    expect(field(renderer, "name")).toBeDefined()
    expect(text(renderer)).not.toContain(GREETING.text)
    expect(fetchMock.mock.calls.length).toBe(calls)
  })
})
