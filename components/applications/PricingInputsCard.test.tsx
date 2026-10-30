// @vitest-environment jsdom
// The pricing card shows only for a product under the product engine, offers the lender's configured segments and the fixed channels,
// and saves what was chosen.
import { act, create } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PricingInputsCard } from "./PricingInputsCard"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
afterEach(() => { delete env.IS_REACT_ACT_ENVIRONMENT; vi.unstubAllGlobals() })

const payload = (over: Record<string, unknown> = {}) => ({
  inputs: { segment: null, channel: "BRANCH", campaignCode: null }, riskGradeRank: 0, open: true,
  options: { segments: ["SALARIED", "SELF_EMPLOYED"], campaigns: ["SPRING27"] },
  price: { interestRatePm: 0.02, baseRatePm: 0.03, productVersion: 4, rule: "Best grades", repayment: { frequency: "WEEKLY", structure: "AMORTISING" } }, ...over,
})

async function mount(body: unknown, calls: Array<{ url: string; method: string; body?: unknown }> = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, json: async () => body }
  }))
  env.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(<PricingInputsCard applicationId="app-1" />) })
  return renderer
}
const byId = (r: ReturnType<typeof create>, id: string) => r.root.find((n) => n.props.id === id && typeof n.type === "string")

describe("PricingInputsCard", () => {
  it("shows nothing for a product that is not under the product engine", async () => {
    const r = await mount(payload({ price: { interestRatePm: 0.03, baseRatePm: 0.03, productVersion: null, rule: null, repayment: null } }))
    expect(r.toJSON()).toBeNull()
  })

  it("shows the price a rule gives, offers the configured segments and campaigns, and shows the channel without offering to change it", async () => {
    const r = await mount(payload())
    const text = JSON.stringify(r.toJSON())
    expect(text).toContain("Best grades")
    expect(text).toContain("2%")
    expect(byId(r, "pi-segment").findAllByType("option").map((o) => o.props.value)).toEqual(["", "SALARIED", "SELF_EMPLOYED"])
    expect(byId(r, "pi-campaign").findAllByType("option").map((o) => o.props.value)).toEqual(["", "SPRING27"])
    expect(byId(r, "pi-channel").type).toBe("p")
    expect(byId(r, "pi-channel").children).toEqual(["BRANCH"])
  })

  it("saves the chosen segment and campaign, and sends no channel: the system sets it", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const r = await mount(payload(), calls)
    await act(async () => { byId(r, "pi-segment").props.onChange({ target: { value: "SALARIED" } }) })
    await act(async () => { byId(r, "pi-campaign").props.onChange({ target: { value: "SPRING27" } }) })
    await act(async () => { r.root.findAll((n) => n.type === "button" && n.children.includes("Save pricing inputs"))[0]!.props.onClick() })
    expect(calls.find((c) => c.method === "PUT")).toEqual({ url: "/api/applications/app-1/pricing-inputs", method: "PUT", body: { segment: "SALARIED", campaignCode: "SPRING27" } })
  })

  it("is read-only once the application is decided", async () => {
    const r = await mount(payload({ open: false }))
    expect(byId(r, "pi-segment").props.disabled).toBe(true)
    expect(r.root.findAll((n) => n.type === "button" && n.children.includes("Save pricing inputs"))).toHaveLength(0)
  })
})
