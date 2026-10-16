// @vitest-environment jsdom
// A real DOM (react-dom createRoot): the card loads its status, the inputs are
// typed into and the buttons clicked as a browser would, and every request it
// makes is read off the fetch mock.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IsaFlowConnectionCard } from "./IsaFlowConnectionCard"

const TOKEN = "pat_card_test_secret_0123456789"
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const disconnected = { configured: true, allowedOrigins: ["https://isaflow.example"], status: "DISCONNECTED", baseUrl: null, companyName: null, connectedAt: null, lastVerifiedAt: null }
const connected = { ...disconnected, status: "CONNECTED", baseUrl: "https://isaflow.example", companyName: "Dev Co", connectedAt: "2026-10-16T08:00:00Z", lastVerifiedAt: "2026-10-16T08:00:00Z" }

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

/** GET answers `status`; each POST answers the next of `posts`. */
async function mount(status: Record<string, unknown>, posts: Response[] = []) {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? posts.shift()! : Response.json(status)))
  vi.stubGlobal("fetch", fetchMock)
  await act(async () => root.render(<IsaFlowConnectionCard />))
}

const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!
const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
async function click(label: string) {
  await act(async () => button(label).click())
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const posted = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
  .map(([url, init]) => ({ url, body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }))

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("IsaFlowConnectionCard", () => {
  it("shows a connected company, address and status from GET /api/integrations/isaflow", async () => {
    await mount(connected)
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/isaflow")
    expect(container.textContent).toContain("Connected")
    expect(container.textContent).toContain("Dev Co")
    expect(container.textContent).toContain("https://isaflow.example")
    expect(input("IsaFlow personal access token").value).toBe("")
    expect(input("IsaFlow address").value).toBe("https://isaflow.example")
  })

  it("connects with the typed address and token, then clears the token and never shows it", async () => {
    await mount(disconnected, [Response.json(connected)])
    expect(input("IsaFlow address").value).toBe("https://isaflow.example")
    await type(input("IsaFlow personal access token"), TOKEN)
    expect(input("IsaFlow personal access token").type).toBe("password")
    await click("Connect IsaFlow")
    expect(posted()).toEqual([{ url: "/api/integrations/isaflow", body: { action: "connect", baseUrl: "https://isaflow.example", token: TOKEN } }])
    expect(input("IsaFlow personal access token").value).toBe("")
    expect(container.innerHTML).not.toContain(TOKEN)
    expect(container.textContent).toContain("IsaFlow is connected.")
    expect(container.textContent).toContain("Dev Co")
  })

  it("verifies and disconnects through the same route, each with its own action", async () => {
    await mount(connected, [Response.json(connected), Response.json(disconnected)])
    await click("Verify")
    await click("Disconnect")
    expect(posted()).toEqual([
      { url: "/api/integrations/isaflow", body: { action: "verify" } },
      { url: "/api/integrations/isaflow", body: { action: "disconnect" } },
    ])
    expect(container.textContent).toContain("IsaFlow disconnected.")
    expect(container.textContent).toContain("Not connected")
  })

  it("shows the server's refusal and keeps the typed token out of the page", async () => {
    await mount(disconnected, [Response.json({ error: "Sign in with two-factor authentication to change the security policy." }, { status: 403 })])
    await type(input("IsaFlow personal access token"), TOKEN)
    await click("Connect IsaFlow")
    expect(container.textContent).toContain("Sign in with two-factor authentication")
    expect(container.textContent).toContain("Not connected")
    expect(container.textContent).not.toContain(TOKEN)
  })

  it("offers no form when the deployment has no allowed IsaFlow address", async () => {
    await mount({ ...disconnected, configured: false, allowedOrigins: [] })
    expect(container.textContent).toContain("ISAFLOW_ALLOWED_ORIGINS")
    expect(container.querySelector("input")).toBeNull()
  })
})
