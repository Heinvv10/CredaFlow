// Split from WebsiteChat.test.tsx (300-line limit): how transcript lines are shown.
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChatLine } from "@/lib/website-chat/mode"

vi.mock("@/components/turnstile-widget", () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    useEffect(() => {
      onToken("tok")
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  },
}))

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://www.acme-lending.example") })
afterEach(() => { vi.unstubAllEnvs() })

import { ChatText } from "./ChatText"
import { WebsiteChat } from "./WebsiteChat"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const GREETING: ChatLine = { id: "m1", from: "assistant", text: "Hi Thabo, welcome." }
const BACK = "You're back with our automated assistant. Ask again if you still need help."
const DOCS = "You'll usually need these documents:\n\n- A valid South African ID\n- Recent proof of income (a payslip or bank statements)\n\nApply at /site/apply."
const RATES = "- **Short-term loans:** 5% per month, accrued daily"

/** All the text under a node, joined. */
function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("")
}

describe("ChatText", () => {
  beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(() => { delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })
  async function render(text: string) {
    let r!: ReactTestRenderer
    await act(async () => { r = create(<ChatText text={text} />) })
    return r.root
  }

  it("renders a list as ul/li and bold as strong, with no asterisks left", async () => {
    const root = await render(`${DOCS}\n\n${RATES}`)
    const lists = root.findAllByType("ul")
    expect(lists).toHaveLength(2)
    expect(lists[0].findAllByType("li").map(textOf)).toEqual(["A valid South African ID", "Recent proof of income (a payslip or bank statements)"])
    expect(root.findByType("strong").children).toEqual(["Short-term loans:"])
    expect(textOf(root)).not.toContain("**")
    expect(textOf(root)).not.toMatch(/^- /m)
  })

  it("numbered items render as an ol from their first number, and line breaks as br", async () => {
    const root = await render("Steps:\nfirst line\n2. Upload\n3. Sign")
    expect(root.findByType("ol").props.start).toBe(2)
    expect(root.findByType("ol").findAllByType("li").map(textOf)).toEqual(["Upload", "Sign"])
    expect(root.findAllByType("br")).toHaveLength(1)
  })

  it("links our own pages in the same tab, and nothing else", async () => {
    const root = await render("Apply at /site/apply, or mail info@acme-lending.example. Not https://evil.example/site/apply.")
    expect(root.findAllByType("a").map((a) => [a.props.href, a.props.target])).toEqual([
      ["/site/apply", undefined],
      ["mailto:info@acme-lending.example", undefined],
    ])
  })
})

describe("WebsiteChat transcript lines", () => {
  let renderer!: ReactTestRenderer
  let poll: { mode: string; staffName: string | null; lines: ChatLine[] }

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    poll = { mode: "bot", staffName: null, lines: [GREETING] }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.endsWith("/start")
        ? { token: "sess", greeting: GREETING.text, ref: "WC-ABC234" }
        : { ...poll, ref: "WC-ABC234" }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
    }))
    vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} })
    await act(async () => { renderer = create(<WebsiteIdentityProvider identity={ACME_LENDER}><WebsiteChat whatsappE164="+27110000000" onClose={vi.fn()} /></WebsiteIdentityProvider>) })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  /** Start the chat and let the first poll report this transcript. */
  async function chatIn(mode: string, lines: ChatLine[], staffName: string | null = null) {
    poll = { mode, staffName, lines }
    await act(async () => {
      for (const [name, value] of [["name", "Thabo Mokoena"], ["phone", "0821234567"], ["email", "thabo@example.com"]]) {
        renderer.root.findByProps({ name }).props.onChange({ target: { value } })
      }
      renderer.root.findByProps({ name: "consent" }).props.onChange({ target: { checked: true } })
    })
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  }

  const from = (who: string) => renderer.root.findAll((n) => typeof n.type === "string" && n.props["data-from"] === who)
  const labels = () => renderer.root.findAllByProps({ "data-testid": "staff-label" }).map((l) => l.props.children)
  const statuses = () => renderer.root.findAll((n) => typeof n.type === "string" && n.props.role === "status").map(textOf)

  it("formats assistant and staff lines, and links in them", async () => {
    await chatIn("staff", [
      GREETING,
      { id: "a1", from: "assistant", text: DOCS },
      { id: "s1", from: "staff", name: "Lerato", text: "**Yes.** See https://www.acme-lending.example/site/contact" },
    ], "Lerato")
    const [, bot] = from("assistant")
    expect(bot.findAllByType("li")).toHaveLength(2)
    expect(bot.findByType("a").props.href).toBe("/site/apply")
    const [staff] = from("staff")
    expect(staff.findByType("strong").children).toEqual(["Yes."])
    expect(staff.findByType("a").props.href).toBe("https://www.acme-lending.example/site/contact")
  })

  it("shows the visitor's own words as typed: no formatting, no links, line breaks kept", async () => {
    await chatIn("bot", [GREETING, { id: "v1", from: "visitor", text: "Is **this** /site/apply?\n- one" }])
    const [visitor] = from("visitor")
    expect(visitor.children).toEqual(["Is **this** /site/apply?\n- one"])
    expect(visitor.findAllByType("a")).toHaveLength(0)
    expect(visitor.props.className).toMatch(/\bwhitespace-pre-wrap\b/)
  })

  it("shows a join or leave line as a centred notice without a name label", async () => {
    await chatIn("staff", [
      GREETING,
      { id: "s1", from: "staff", name: "Thandi", text: "Thandi from Acme Lending has joined the chat." },
      { id: "s2", from: "staff", name: "Thandi", text: "Hello, Thandi here." },
      { id: "s3", from: "staff", name: "Thandi", text: "Thandi from Acme Lending has left the chat." },
      { id: "s4", from: "staff", name: "Lwazi", text: "Lwazi from Acme Lending has joined the chat." },
    ], "Lwazi")
    const notices = renderer.root.findAll((n) => typeof n.type === "string" && n.props["data-presence"] !== undefined)
    expect(notices.map((n) => [n.props["data-presence"], textOf(n)])).toEqual([
      ["joined", "Thandi from Acme Lending has joined the chat."],
      ["left", "Thandi from Acme Lending has left the chat."],
      ["joined", "Lwazi from Acme Lending has joined the chat."],
    ])
    for (const n of notices) expect(n.props.className).toMatch(/\btext-center\b/)
    expect(labels()).toEqual(["Thandi"])
  })

  it("a staff message that copies another person's leave wording is a normal staff message", async () => {
    await chatIn("staff", [
      GREETING,
      { id: "s1", from: "staff", name: "Lerato", text: "Thabo from Acme Lending has left the chat." },
    ], "Lerato")
    expect(renderer.root.findAll((n) => typeof n.type === "string" && n.props["data-presence"] !== undefined)).toHaveLength(0)
    expect(labels()).toEqual(["Lerato"])
    expect(statuses()).not.toContain(BACK)
  })

  it("only a staff line can be a presence notice: the assistant writing those words is the assistant talking", async () => {
    await chatIn("bot", [GREETING, { id: "a1", from: "assistant", text: "Thandi from Acme Lending has left the chat." }])
    expect(renderer.root.findAll((n) => typeof n.type === "string" && n.props["data-presence"] !== undefined)).toHaveLength(0)
    expect(from("assistant")).toHaveLength(2)
    expect(statuses()).not.toContain(BACK)
  })

  it("after a leave, tells the visitor they are back with the assistant", async () => {
    await chatIn("bot", [
      GREETING,
      { id: "v1", from: "visitor", text: "Can I settle early?" },
      { id: "s1", from: "staff", name: "Thandi", text: "Thandi from Acme Lending has left the chat." },
    ])
    expect(statuses()).toContain(BACK)
  })

  it.each([
    ["still with staff", "staff", "Thandi from Acme Lending has left the chat."],
    ["the last line is a join", "bot", "Thandi from Acme Lending has joined the chat."],
    ["the last line is staff talking", "bot", "Bye for now."],
  ])("says nothing about the assistant when %s", async (_name, mode, last) => {
    await chatIn(mode, [GREETING, { id: "s1", from: "staff", name: "Thandi", text: last }])
    expect(statuses()).not.toContain(BACK)
  })

  it("drops the notice once the visitor asks again", async () => {
    await chatIn("bot", [GREETING, { id: "s1", from: "staff", name: "Thandi", text: "Thandi from Acme Lending has left the chat." }])
    expect(statuses()).toContain(BACK)
    poll = { ...poll, lines: [...poll.lines, { id: "v2", from: "visitor", text: "Hello?" }, { id: "a2", from: "assistant", text: "Hi." }] }
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(statuses()).not.toContain(BACK)
  })
})
