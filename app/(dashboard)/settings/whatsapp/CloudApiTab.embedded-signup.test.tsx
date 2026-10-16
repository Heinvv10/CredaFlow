// Embedded Signup completes only once BOTH halves have arrived: the auth code
// (FB.login callback) and the waba/phone ids (a window "message" from Meta's
// iframe). Arrival order is not guaranteed. Separate from CloudApiTab.test.tsx
// because the Meta app credentials are module-level constants, read at import.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_META_APP_ID = "test-app"
  process.env.NEXT_PUBLIC_META_ES_CONFIG_ID = "test-config"
})

import { CloudApiTab } from "./CloudApiTab"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer
let fetchMock: ReturnType<typeof vi.fn>
let onMessage: (event: { origin: string; data: string }) => void
let finishLogin: () => void

function text(node: unknown): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(text).join("")
  if (node && typeof node === "object" && "props" in (node as { props?: unknown })) {
    return text((node as { props?: { children?: unknown } }).props?.children)
  }
  return ""
}

function connectButton() {
  return renderer.root.findAllByType("button").find((b) => /Connect|Connecting/.test(text(b.props.children)))!
}

function pageText(): string {
  return renderer.root.findAllByType("div").map((d) => text(d.props.children)).join(" ")
}

async function sendIds() {
  await act(async () => {
    onMessage({
      origin: "https://www.facebook.com",
      data: JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH",
        data: { waba_id: "waba-1", phone_number_id: "pn-1" },
      }),
    })
  })
}

beforeEach(async () => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("document", { getElementById: () => ({}) })
  vi.stubGlobal("window", {
    addEventListener: vi.fn((type: string, handler: typeof onMessage) => { if (type === "message") onMessage = handler }),
    removeEventListener: vi.fn(),
    FB: {
      init: vi.fn(),
      login: vi.fn((cb: (r: { authResponse?: { code?: string } }) => void) => {
        finishLogin = () => cb({ authResponse: { code: "auth-code" } })
      }),
    },
  })
  await act(async () => { renderer = create(<CloudApiTab />) })
  await act(async () => { connectButton().props.onClick() })
})

afterEach(async () => {
  await act(async () => renderer?.unmount())
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("CloudApiTab embedded signup", () => {
  it("does not call the server with only the code", async () => {
    await act(async () => { finishLogin() })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(text(connectButton().props.children)).toBe("Connect WhatsApp (official)")
  })

  it("shows Connecting while the request is in flight, then the connected number", async () => {
    let resolveFetch!: (r: unknown) => void
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve }))
    await act(async () => { finishLogin() })
    await sendIds()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }]
    expect(url).toBe("/api/settings/whatsapp/embedded-signup")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body)).toEqual({ code: "auth-code", wabaId: "waba-1", phoneNumberId: "pn-1" })
    expect(text(connectButton().props.children)).toBe("Connecting…")
    expect(connectButton().props.disabled).toBe(true)

    await act(async () => { resolveFetch({ ok: true, json: async () => ({ ok: true }) }) })

    expect(pageText()).toContain("WhatsApp Cloud API connected.")
    expect(pageText()).toContain("Connected · pn-1")
  })

  it("reports a refusal and lets the operator try again", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Code expired" }) })
    await act(async () => { finishLogin() })
    await sendIds()

    expect(pageText()).toContain("Code expired")
    expect(text(connectButton().props.children)).toBe("Connect WhatsApp (official)")
    expect(connectButton().props.disabled).toBe(false)
  })

  it("clears the previous outcome when a new attempt starts", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Code expired" }) })
    await act(async () => { finishLogin() })
    await sendIds()
    expect(pageText()).toContain("Code expired")

    fetchMock.mockReturnValueOnce(new Promise(() => undefined))
    await act(async () => { connectButton().props.onClick() })
    await act(async () => { finishLogin() })
    await sendIds()

    expect(pageText()).not.toContain("Code expired")
  })
})
