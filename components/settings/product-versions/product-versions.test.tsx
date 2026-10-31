// @vitest-environment jsdom
// The version form turns what a person types (rand, percent) into the stored payload, in cents and decimals, and files it
// as a change request for a second person; the workspace offers proposing only to someone who may, and shows each version's status.
import { act, create } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { PricingRuleForm } from "./PricingRuleForm"
import { ProductVersionsWorkspace } from "./ProductVersionsWorkspace"
import { VersionForm } from "./VersionForm"
import type { EngineOverview } from "./types"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
afterEach(() => { delete env.IS_REACT_ACT_ENVIRONMENT; vi.unstubAllGlobals() })

async function mount(element: React.ReactElement) {
  env.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(element) })
  return renderer
}
const byId = (r: ReturnType<typeof create>, id: string) => r.root.find((n) => n.props.id === id && typeof n.type === "string")
const type = (r: ReturnType<typeof create>, id: string, value: string) => act(async () => { byId(r, id).props.onChange({ target: { value, checked: value === "true" } }) })
const click = (r: ReturnType<typeof create>, label: string) => act(async () => { r.root.findAll((n) => n.type === "button" && n.children.includes(label))[0]!.props.onClick() })

const product = { id: "p1", code: "PERS", name: "Personal", productType: "PERSONAL" as const, active: true, minAmount: 100_000, maxAmount: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.05, initiationFeeMax: 100_000, monthlyServiceFee: 6_900 }
const config = { minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.05, initiationFeeMaxCents: 100_000, monthlyServiceFeeCents: 6_900, repayment: null, collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null } }
const overview = (over: Partial<EngineOverview> = {}): EngineOverview => ({
  today: "2027-03-01", nca: false, currency: "ZAR" as const, products: [product], rules: [], requests: [], canManage: true, canApprove: false,
  versions: [
    { id: "v2", productId: "p1", version: 2, effectiveFrom: "2027-04-01", status: "SCHEDULED", reason: "Spring pricing", config: { ...config, interestRatePm: 0.025, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 2 } }, createdAt: "2027-03-01T08:00:00Z" },
    { id: "v1", productId: "p1", version: 1, effectiveFrom: "2027-01-01", status: "IN_EFFECT", reason: "Launch", config, createdAt: "2027-01-01T08:00:00Z" },
  ],
  ...over,
})

describe("VersionForm", () => {
  it("files the typed values as a change request in cents and decimals, then submits it", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body?: string }) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
      return { ok: true, status: 200, json: async () => ({ request: { id: "cr1" } }) }
    }))
    const r = await mount(<VersionForm overview={overview()} product={product} onDone={() => undefined} onCancel={() => undefined} />)
    await type(r, "pv-date", "2027-05-01")
    await type(r, "pv-reason", "Weekly repayments for the salaried segment")
    await type(r, "pv-maxamt", "9000")
    await type(r, "pv-rate", "2.5")
    await act(async () => { byId(r, "pv-reason"); r.root.find((n) => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } }) })
    await act(async () => { byId(r, "pv-freq").props.onChange({ target: { value: "WEEKLY" } }); byId(r, "pv-grace").props.onChange({ target: { value: "PRINCIPAL_ONLY" } }) })
    await type(r, "pv-graceper", "2")
    await click(r, "Submit for approval")
    expect(calls.map((c) => c.url)).toEqual(["/api/maker-checker", "/api/maker-checker/cr1/submit"])
    expect(calls[0]!.body).toMatchObject({
      kind: "PRODUCT_VERSION", title: "PERS: new version from 2027-05-01",
      payload: {
        productId: "p1", effectiveFrom: "2027-05-01", reason: "Weekly repayments for the salaried segment",
        config: { maxAmountCents: 900_000, interestRatePm: 0.025, monthlyServiceFeeCents: 6_900, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 2 } },
      },
    })
  })

  it("shows what the server refused, and does not submit a draft it could not save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: "Invalid", problems: ["payload.config.interestRatePm: above the ceiling"] }) })))
    const r = await mount(<VersionForm overview={overview()} product={product} onDone={() => undefined} onCancel={() => undefined} />)
    await click(r, "Submit for approval")
    expect(JSON.stringify(r.toJSON())).toContain("above the ceiling")
  })

  it("withdraws a draft whose submit the server refused, so nothing is left to resubmit", async () => {
    const urls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith("/submit")) return { ok: false, status: 422, json: async () => ({ error: "Refused", problems: ["payload.config.repayment.frequency: needs legal sign-off"] }) }
      return { ok: true, status: 200, json: async () => ({ request: { id: "cr1" } }) }
    }))
    const r = await mount(<VersionForm overview={overview()} product={product} onDone={() => undefined} onCancel={() => undefined} />)
    await click(r, "Submit for approval")
    expect(urls).toEqual(["/api/maker-checker", "/api/maker-checker/cr1/submit", "/api/maker-checker/cr1/withdraw"])
    expect(JSON.stringify(r.toJSON())).toContain("needs legal sign-off")
  })

  it("explains the NCA limit on structures to a lender that is under the Act", async () => {
    const r = await mount(<VersionForm overview={overview({ nca: true })} product={product} onDone={() => undefined} onCancel={() => undefined} />)
    expect(JSON.stringify(r.toJSON())).toContain("legal team")
  })
})

describe("PricingRuleForm", () => {
  it("files a rule with a risk-grade range, a segment and a channel, the rate as a decimal", async () => {
    const bodies: unknown[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body?: string }) => { bodies.push(init.body ? JSON.parse(init.body) : undefined); return { ok: true, status: 200, json: async () => ({ request: { id: "cr2" } }) } }))
    const r = await mount(<PricingRuleForm overview={overview()} onDone={() => undefined} onCancel={() => undefined} />)
    await type(r, "pr-name", "Salaried mobile, best grades")
    await type(r, "pr-segment", "SALARIED")
    await type(r, "pr-channel", "DIGITAL")
    await type(r, "pr-rankmin", "0")
    await type(r, "pr-rankmax", "1")
    await type(r, "pr-rate", "2.25")
    await click(r, "Submit for approval")
    expect(bodies[0]).toMatchObject({ kind: "PRODUCT_PRICING_RULE", payload: { action: "CREATE", rule: { productId: null, segment: "SALARIED", channel: "DIGITAL", riskRankMin: 0, riskRankMax: 1, rate: { mode: "SET", value: 0.0225 }, campaignCode: null } } })
  })
})

describe("ProductVersionsWorkspace", () => {
  const text = (r: ReturnType<typeof create>) => JSON.stringify(r.toJSON())

  it("lists each version with its status and repayment structure", async () => {
    const r = await mount(<ProductVersionsWorkspace overview={overview()} />)
    const t = text(r)
    expect(t).toContain("Scheduled")
    expect(t).toContain("In effect")
    expect(t).toContain("Weekly")
    expect(t).toContain("principal-only")
    expect(t).toContain("Spring pricing")
  })

  it("offers Propose a new version to someone who may, and not to someone who may only read", async () => {
    expect(text(await mount(<ProductVersionsWorkspace overview={overview()} />))).toContain("Propose a new version")
    expect(text(await mount(<ProductVersionsWorkspace overview={overview({ canManage: false })} />))).not.toContain("Propose a new version")
  })

  it("counts under Approvals what is submitted, and only my own drafts: another person's draft is not waiting on me", async () => {
    const row = (id: string, status: "DRAFT" | "SUBMITTED", mine: boolean) => ({ id, kind: "PRODUCT_VERSION", title: id, status, mine, payload: {} }) as unknown as EngineOverview["requests"][number]
    const requests = [row("a", "SUBMITTED", false), row("b", "DRAFT", true), row("c", "DRAFT", false)]
    expect(text(await mount(<ProductVersionsWorkspace overview={overview({ requests })} />))).toContain("\" (2)\"")
  })

  it("shows amounts in the lender's currency: the loti for a Lesotho lender", async () => {
    expect(text(await mount(<ProductVersionsWorkspace overview={overview({ currency: "LSL" })} />))).toContain("M 1,000.00")
    expect(text(await mount(<ProductVersionsWorkspace overview={overview()} />))).toContain("R 1,000.00")
  })

  it("says so for a product that has no versions", async () => {
    expect(text(await mount(<ProductVersionsWorkspace overview={overview({ versions: [] })} />))).toContain("No versions yet")
  })
})
