// @vitest-environment jsdom
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AccountingWorkspace } from "./AccountingWorkspace"
const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const reply = (body: unknown) => ({ ok: true, json: async () => body })
function text(renderer: ReactTestRenderer) { return JSON.stringify(renderer.toJSON()) }
function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(n => n.type === "button").find(n => JSON.stringify(n.props.children).includes(label))!
}
afterEach(() => { vi.unstubAllGlobals(); delete actEnv.IS_REACT_ACT_ENVIRONMENT })
describe("accounting settings-to-close journey", () => {
  it("refreshes confirmation, go-live, VAT, mapping and close state without a page reload", async () => {
    actEnv.IS_REACT_ACT_ENVIRONMENT = true
    let settings = { mappingConfirmedAt: null as string | null, mappingConfirmedRoles: [], goLiveMonth: null as string | null, vatRegistered: false, vatRateBps: 1500 }
    let closed = false
    let releaseClose: (() => void) | undefined
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/accounting/settings") {
        if (init?.method === "POST") settings = { ...settings, mappingConfirmedAt: "2026-10-17T12:00:00Z" }
        if (init?.method === "PUT") settings = { ...settings, ...JSON.parse(init.body!) }
        return reply({ ...settings })
      }
      if (url === "/api/accounting/mappings") {
        if (init?.method === "PUT") settings = { ...settings, mappingConfirmedAt: null }
        return reply({ mappings: [{ role: "BANK", code: "1000", name: "Synthetic bank", taxCode: null, vatInclusive: false, isDefault: true, description: "Bank", defaultCode: "1000" }] })
      }
      if (url === "/api/accounting/periods") {
        if (init?.method === "POST") { await new Promise<void>(resolve => { releaseClose = resolve }); closed = true }
        return reply({ batches: [] })
      }
      const period = new URL(url, "http://localhost").searchParams.get("period")
      return reply({ period, label: period, closed, batchId: null, goLive: period === settings.goLiveMonth, entryCount: settings.vatRegistered ? 2 : 1, debitCents: 100, creditCents: 100, accounts: [], events: {}, reconciliation: null, refusal: settings.mappingConfirmedAt ? null : { code: "MAPPING_NOT_CONFIRMED", message: "Confirm mapping first" } })
    })
    vi.stubGlobal("fetch", fetchMock)
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<AccountingWorkspace initialPeriod="2026-08" canAdmin locked={false} xeroConnected={false} isaflowConnected={false} />) })
    expect(text(renderer)).toContain("Confirm mapping first")
    await act(async () => { await button(renderer, "confirm it").props.onClick() })
    expect(text(renderer)).not.toContain("Confirm mapping first")
    await act(async () => { renderer.root.findByProps({ id: "go-live" }).props.onChange({ target: { value: "2026-04" } }) })
    await act(async () => { await button(renderer, "Save go-live month").props.onClick() })
    expect(renderer.root.findByProps({ id: "period" }).props.value).toBe("2026-04")
    expect(text(renderer)).toContain("Go-live month:")
    await act(async () => { await button(renderer, "Lender is VAT-registered").props.onClick() })
    expect(settings.vatRegistered).toBe(true)
    expect(text(renderer)).toContain("VAT-registered: ")
    await act(async () => { await button(renderer, "Save mapping").props.onClick() })
    expect(text(renderer)).toContain("Mapping not confirmed")
    expect(text(renderer)).toContain("Confirm mapping first")
    expect(button(renderer, "Close ").props.disabled).toBe(true)
    await act(async () => { await button(renderer, "confirm it").props.onClick() })
    expect(button(renderer, "Close ").props.disabled).toBe(false)
    let closing!: Promise<void>
    await act(async () => { closing = button(renderer, "Close ").props.onClick() })
    expect(button(renderer, "Save mapping").props.disabled).toBe(true)
    expect(button(renderer, "confirm it").props.disabled).toBe(true)
    expect(renderer.root.findByProps({ id: "go-live" }).props.disabled).toBe(true)
    await act(async () => { releaseClose?.(); await closing })
    expect(text(renderer)).toContain("Closed")
    expect(renderer.root.findByProps({ id: "go-live" }).props.disabled).toBe(true)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST" && init.body === '{"period":"2026-04"}')).toHaveLength(1)
  })
})
