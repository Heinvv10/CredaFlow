import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CloudApiTab } from "./CloudApiTab"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer
let fetchMock: ReturnType<typeof vi.fn>

async function render(props: Parameters<typeof CloudApiTab>[0] = {}) {
  await act(async () => { renderer = create(<CloudApiTab {...props} />) })
  return renderer
}

// react-test-renderer's own findAllByType (not a hand-rolled deep predicate)
// is what avoids two problems at once: (1) React 19's dev-mode owner-stack
// tracking makes a plain JSON.stringify of pre-render children throw
// ("Converting circular structure to JSON") on the element's _owner chain,
// and (2) a hand-rolled `findAll(pred, { deep: true })` run after a prior
// state update can return the same button twice — a stale pre-update
// instance alongside the fresh one — so `[0]` can silently grab the wrong
// snapshot. collectText walks props.children directly, no serialization.
function collectText(node: unknown): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(collectText).join("")
  if (node && typeof node === "object" && "props" in (node as { props?: unknown })) {
    return collectText((node as { props?: { children?: unknown } }).props?.children)
  }
  return ""
}

function findButton(label: string) {
  return renderer.root.findAllByType("button").find((b) => collectText(b.props.children).includes(label))!
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  // environment: "node" — the component subscribes to the embedded-signup
  // postMessage on mount. The stub has no `document`, which is safe here:
  // NEXT_PUBLIC_META_APP_ID is unset in tests, and CloudApiTab's script-load
  // effect checks `!META_APP_ID` before it ever touches `document`.
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})

afterEach(async () => {
  await act(async () => renderer?.unmount())
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("CloudApiTab", () => {
  // Claiming a connection that isn't there sends staff hunting for a fault
  // in the wrong place, so the connected state must be driven by the number.
  it("names the connected number and provider when one is stored", async () => {
    const json = JSON.stringify((await render({ wabaPhoneNumberId: "123456", waProvider: "WA_CLOUD" })).toJSON())
    expect(json).toContain("123456")
    expect(json).toContain("WA_CLOUD")
  })

  it("offers Connect, disabled, when Meta app credentials are not configured", async () => {
    await render()
    expect(findButton("Connect WhatsApp (official)").props.disabled).toBe(true)
  })

  it("DELETEs the stored connection and drops the connected state", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    // A number that isn't a substring of the "Test Connection" card's static
    // placeholder ("27821234567 or 0821234567") — "123456" is, which made
    // this assertion pass even when the connected state didn't clear.
    await render({ wabaPhoneNumberId: "998877" })

    await act(async () => { await findButton("Disconnect").props.onClick() })

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/whatsapp", { method: "DELETE" })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("998877")
  })

  // A simulated send is not a delivered message. Reporting it as "Sent!"
  // would let an operator sign off a channel that never sent anything.
  it("labels a simulated test send as simulated", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, simulated: true, messageId: "sim-1" }) })
    await render()
    const input = renderer.root.findAll((n) => n.type === "input", { deep: true })[0]
    await act(async () => { input.props.onChange({ target: { value: "27821234567" } }) })
    await act(async () => { await findButton("Send Test").props.onClick() })

    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("Simulated — no WhatsApp message was sent.")
    expect(json).not.toContain("Sent! Message ID")
  })
})
