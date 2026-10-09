import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn() }))
vi.mock("@/components/support/WebsiteChat", () => ({ WebsiteChat: () => <div data-testid="chat-panel" /> }))

import { WebsiteChat } from "@/components/support/WebsiteChat"
import { WEBSITE_INTENTS } from "@/lib/support/whatsapp-intents"
import { WebsiteSupport } from "./WebsiteSupport"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

async function render(status: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(status))
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<WebsiteSupport whatsappE164="+27110000000" />) })
  await act(async () => { renderer.root.findByType("button").props.onClick() })
  return renderer
}

/** Labels of the launcher's menu items (links and the chat button). */
function items(renderer: ReactTestRenderer) {
  return renderer.root.findAll((n) => typeof n.type === "string" && n.props.role === "menuitem")
    .map((n) => [n.props.children].flat().filter((c) => typeof c === "string").join(""))
}

describe("WebsiteSupport launcher", () => {
  beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true; vi.spyOn(console, "error").mockImplementation(() => undefined) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it("chat enabled: only the assistant and the complaint option", async () => {
    const r = await render(async () => new Response(JSON.stringify({ enabled: true })))
    expect(items(r)).toEqual(["Chat with our assistant", "Log a complaint"])
  })
  it("chat disabled: the four WhatsApp intents", async () => {
    const r = await render(async () => new Response(JSON.stringify({ enabled: false })))
    expect(items(r)).toEqual(WEBSITE_INTENTS.map((i) => i.label))
  })
  it("status not ok: the four WhatsApp intents", async () => {
    const r = await render(async () => new Response("{}", { status: 500 }))
    expect(items(r)).toEqual(WEBSITE_INTENTS.map((i) => i.label))
  })
  const panelOpen = (r: ReactTestRenderer) => r.root.findAllByProps({ "data-testid": "chat-panel" }).length === 1
  async function mountWith(stored: string | null, enabled = true) {
    vi.stubGlobal("sessionStorage", { getItem: () => stored, setItem: () => {}, removeItem: () => {} })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled }))))
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<WebsiteSupport whatsappE164="+27110000000" />) })
    return renderer
  }
  it("reopens the chat panel on a page where a chat is under way", async () => {
    expect(panelOpen(await mountWith(JSON.stringify({ token: "sess" })))).toBe(true)
  })
  it("a stored value marked open reopens the panel", async () => {
    expect(panelOpen(await mountWith(JSON.stringify({ token: "sess", open: true })))).toBe(true)
  })
  it("keeps the panel shut after the visitor closed it, though the chat is stored", async () => {
    expect(panelOpen(await mountWith(JSON.stringify({ token: "sess", open: false })))).toBe(false)
  })
  it("close records open:false, and picking the chat from the launcher opens the panel again and records open:true", async () => {
    const store = new Map([["cf-website-chat", JSON.stringify({ token: "sess" })]])
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true }))))
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<WebsiteSupport whatsappE164="+27110000000" />) })
    expect(panelOpen(renderer)).toBe(true)
    await act(async () => { renderer.root.findByType(WebsiteChat).props.onClose() })
    expect(panelOpen(renderer)).toBe(false)
    expect(JSON.parse(store.get("cf-website-chat")!)).toEqual({ token: "sess", open: false })
    // Remount (a page load): still shut.
    await act(async () => { renderer.unmount() })
    await act(async () => { renderer = create(<WebsiteSupport whatsappE164="+27110000000" />) })
    expect(panelOpen(renderer)).toBe(false)
    await act(async () => { renderer.root.findByType("button").props.onClick() })
    await act(async () => { renderer.root.findAll((n) => n.props.role === "menuitem")[0].props.onClick() })
    expect(panelOpen(renderer)).toBe(true)
    expect(JSON.parse(store.get("cf-website-chat")!)).toEqual({ token: "sess", open: true })
  })
  it("keeps the panel shut on a page where no chat was started", async () => {
    expect(panelOpen(await mountWith(null))).toBe(false)
  })
  it("keeps the panel shut when the chat has been switched off since", async () => {
    expect(panelOpen(await mountWith(JSON.stringify({ token: "sess" }), false))).toBe(false)
  })
  it("keeps the panel shut when storage cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true }))))
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("denied") } })
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<WebsiteSupport whatsappE164="+27110000000" />) })
    expect(panelOpen(renderer)).toBe(false)
  })
  it("status fetch failing: the four WhatsApp intents", async () => {
    const r = await render(async () => { throw new Error("offline") })
    expect(items(r)).toEqual(WEBSITE_INTENTS.map((i) => i.label))
  })
})
