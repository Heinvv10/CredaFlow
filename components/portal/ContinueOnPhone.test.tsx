import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContinueOnPhone } from "./ContinueOnPhone"

const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let renderer!: ReactTestRenderer

beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(async () => {
  await act(async () => renderer.unmount())
  vi.unstubAllGlobals()
  delete g.IS_REACT_ACT_ENVIRONMENT
})

describe("ContinueOnPhone", () => {
  it("asks for a one-time link and shows it as a QR code and a link", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: "https://portal.example.test/selfie/abc", qr: "data:image/png;base64,AAAA" }),
    }))
    vi.stubGlobal("fetch", fetchMock)
    await act(async () => { renderer = create(<ContinueOnPhone />) })
    await act(async () => { await renderer.root.findByType("button").props.onClick() })

    expect(fetchMock).toHaveBeenCalledWith("/api/portal/selfie-link", { method: "POST" })
    expect(renderer.root.findByType("img").props.src).toBe("data:image/png;base64,AAAA")
    expect(renderer.root.findByType("a").props.href).toBe("https://portal.example.test/selfie/abc")
  })

  it("warns before and after that an earlier link stops working", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: "https://portal.example.test/selfie/abc", qr: "data:image/png;base64,AAAA", replacedEarlierLink: true }),
    })))
    await act(async () => { renderer = create(<ContinueOnPhone />) })
    expect(JSON.stringify(renderer.toJSON())).toContain("This replaces any selfie link we sent you before.")
    await act(async () => { await renderer.root.findByType("button").props.onClick() })
    expect(JSON.stringify(renderer.toJSON())).toContain("The selfie link we sent you earlier no longer works.")
  })

  it("shows the server's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "You have no application waiting for a photo." }) })))
    await act(async () => { renderer = create(<ContinueOnPhone />) })
    await act(async () => { await renderer.root.findByType("button").props.onClick() })
    expect(JSON.stringify(renderer.toJSON())).toContain("You have no application waiting for a photo.")
  })
})
