// Split from WebsiteChat.test.tsx (300-line limit): what a visitor nobody could join is offered.
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { waHref } from "@/lib/support/whatsapp-intents"
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

describe("WebsiteChat: the fallback block", () => {
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

  it("fallback: links to WhatsApp with the reference and the last question, and keeps the input", async () => {
    const question = "q".repeat(350)
    await chatIn("fallback", [GREETING, { id: "m2", from: "visitor", text: "first" }, { id: "m3", from: "visitor", text: question }])
    const link = renderer.root.findByType("a")
    expect(link.props.children).toBe("Continue on WhatsApp")
    expect(link.props.href).toBe(waHref("+27110000000", `Hi, I was chatting on your website (ref WC-ABC234). ${"q".repeat(300)}`))
    expect(link.props.target).toBe("_blank")
    expect(link.props.rel).toBe("noopener noreferrer")
    // Says first that nobody is there, then what the visitor can do about it.
    const out = text(renderer)
    const order = ["No consultant is available right now.", "Continue on WhatsApp", "or we'll call you on the number you gave us during business hours."].map((part) => out.indexOf(part))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(out).toContain(AUTOMATED)
    expect(renderer.root.findAllByType("textarea")).toHaveLength(1)
    expect(renderer.root.findByProps({ children: "Send" }).props.disabled).toBe(false)
  })

  it.each([
    ["an emoji on the 300-character boundary", "x".repeat(299) + "😀", "x".repeat(299) + "😀"],
    ["an emoji just past it", "x".repeat(300) + "😀", "x".repeat(300)],
    ["a pasted half of a surrogate pair", "Hello \uD83D there \uDE00", "Hello  there "],
  ])("fallback: builds the link from whole characters only, given %s", async (_case, question, sent) => {
    await chatIn("fallback", [GREETING, { id: "m2", from: "visitor", text: question }])
    expect(renderer.root.findByType("a").props.href).toBe(waHref("+27110000000", `Hi, I was chatting on your website (ref WC-ABC234). ${sent}`))
  })

  it("fallback: a compact block, so the conversation above it stays readable on a phone", async () => {
    await chatIn("fallback")
    const block = renderer.root.findByProps({ "data-testid": "chat-fallback" })
    const [line, link, after] = block.children as ReactTestInstance[]
    expect([line.props.children, link.props.children, after.props.children]).toEqual([
      "No consultant is available right now.", "Continue on WhatsApp", "or we'll call you on the number you gave us during business hours.",
    ])
    expect(block.props.className).toContain("py-1.5")
    expect(link.props.className).toContain("py-1.5")
    expect(after.props.className).toContain("text-[11px]")
    // Never taller than the room between the launcher and the site header (see WebsiteChat.tsx).
    const panel = renderer.root.findByProps({ "data-testid": "chat-panel" }).props.className
    expect(panel).toContain("max-h-[calc(100dvh-10.5rem)]")
    expect(panel).toContain("sm:max-h-[min(70vh,calc(100dvh-10.5rem))]")
  })

  it("fallback: omits the question when the visitor has not written yet", async () => {
    await chatIn("fallback")
    expect(renderer.root.findByType("a").props.href).toBe(waHref("+27110000000", "Hi, I was chatting on your website (ref WC-ABC234)."))
  })

  it("scrolls the conversation to the bottom when the mode changes, not only when a line arrives", async () => {
    // A DOM node for the log: react-test-renderer has none of its own.
    const scrolled: number[] = []
    const log = { scrollHeight: 500, set scrollTop(v: number) { scrolled.push(v) } }
    await act(async () => renderer.unmount())
    await act(async () => {
      renderer = create(<WebsiteIdentityProvider identity={ACME_LENDER}><WebsiteChat whatsappE164="+27110000000" onClose={vi.fn()} /></WebsiteIdentityProvider>, { createNodeMock: (el) => ((el.props as { role?: string }).role === "log" ? log : null) })
    })
    await chatIn("waiting")
    const after = scrolled.length
    // The same lines, a new mode: the fallback block mounts under the log and pushes it up.
    answers.poll = { status: 200, body: { mode: "fallback", staffName: null, ref: "WC-ABC234", lines: [GREETING] } }
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(renderer.root.findAllByProps({ "data-testid": "chat-fallback" })).toHaveLength(1)
    expect(scrolled.length).toBeGreaterThan(after)
    expect(scrolled.at(-1)).toBe(500)
  })
})
