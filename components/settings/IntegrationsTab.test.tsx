// @vitest-environment jsdom
// Config and the notification log load on mount; a save re-reads the config.
import { createRoot } from "react-dom/client"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { IntegrationsTab } from "./IntegrationsTab"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function config(overrides: Record<string, unknown> = {}) {
  return {
    bulkSmsKey: "", netcashKey: "", transunionKey: "", smileIdentityKey: "",
    netcashDebitOrderKey: "", netcashRiskReportsKey: "",
    bulkSmsConfigured: false, netcashConfigured: false, transunionConfigured: false,
    smileIdentityConfigured: false, netcashDebitOrderConfigured: false, netcashRiskReportsConfigured: false,
    collectionsEngineEnabled: false, collectionProvider: null, experianConfigured: false, experianEnv: "",
    ...overrides,
  }
}

function reply(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function renderedText(renderer: ReactTestRenderer): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === "string") out.push(node)
    else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === "object" && "children" in node) walk((node as { children: unknown }).children)
  }
  walk(renderer.toJSON())
  return out.join(" ").replace(/\s+/g, " ")
}

async function mount() {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<IntegrationsTab />) })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("IntegrationsTab", () => {
  it("loads the config and the notification log on mount", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("logs=true")
        ? reply({ logs: [{ id: "l1", event: "LOAN_APPROVED", channel: "EMAIL", status: "SENT", error: null, createdAt: "2026-09-01T10:00:00.000Z" }] })
        : reply(config({ bulkSmsConfigured: true }))
    )
    vi.stubGlobal("fetch", fetchMock)

    const text = renderedText(await mount())

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/integrations")
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/integrations?logs=true")
    expect(text).toContain("Configured")
    expect(text).toContain("LOAN_APPROVED")
  })

  it("names collection setup prerequisites without development-phase instructions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("logs=true") ? reply({ logs: [] }) : reply(config())))
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => { root.render(<IntegrationsTab />) })
      const tab = [...host.querySelectorAll("button")].find(b => b.textContent === "Collections")!
      await act(async () => { tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })) })
      expect(host.textContent).toContain("provider and mandate setup is verified")
      expect(host.textContent).not.toContain("Phase 7")
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it("leaves the defaults when the routes refuse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, false, 403)))
    const text = renderedText(await mount())
    expect(text).toContain("Not configured")
    expect(text).toContain("No notifications yet")
  })

  it("re-reads the config after a key is saved", async () => {
    let saved = false
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "PATCH") {
        saved = true
        return reply({})
      }
      if (url.includes("logs=true")) return reply({ logs: [] })
      return reply(config({ bulkSmsConfigured: saved, bulkSmsKey: saved ? "****1234" : "" }))
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    expect(renderedText(renderer)).toContain("Not configured")
    const keyField = renderer.root.findAllByType("input")[0]
    await act(async () => { keyField.props.onChange({ target: { value: "user:pass" } }) })
    const save = renderer.root.findAllByType("button").find((b) => b.props.children === "Save")
    await act(async () => { await save?.props.onClick() })

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/settings/integrations" && init?.method !== "PATCH")).toHaveLength(2)
    expect(renderedText(renderer)).toContain("Configured")
  })
})
