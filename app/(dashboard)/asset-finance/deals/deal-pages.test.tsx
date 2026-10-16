import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DealDetail, DealListRow } from "@/lib/asset-finance/deal-detail"

const mocks = vi.hoisted(() => ({ rows: [] as DealListRow[] }))
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock("next/navigation", () => ({ usePathname: () => "/asset-finance/deals", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/lib/asset-finance/staff-page", () => ({ requireAssetFinanceStaffPage: vi.fn(async () => ({ tenantId: "t-1", canManage: false })) }))
vi.mock("@/lib/asset-finance/deal-detail", () => ({ loadDealList: vi.fn(async () => mocks.rows) }))

import { renderedText } from "@/components/asset-finance/lease/lease-test-helpers"
import DealsPage from "./page"
import { ClassificationPanel, DealSummaryPanel } from "./[id]/DealSummaryPanels"
import { DecidePanel } from "./[id]/DecidePanel"
import { DealExceptionsNotice } from "./[id]/DealExceptionsNotice"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})

async function text(element: React.ReactElement): Promise<string> {
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(element) })
  return renderedText(renderer)
}

function deal(over: Partial<DealDetail> = {}): DealDetail {
  return {
    id: "deal-1", status: "SUBMITTED", contractType: "INSTALMENT_SALE", createdAt: "2026-10-01T08:00:00.000Z", baseInstalmentCents: 2_000_000,
    application: {
      id: "app-1", reference: "AF-TEST0001", status: "SUBMITTED", ncaRegime: "NON_NCA", ncaClassificationRule: null, decisionReason: null,
      appliedAmount: 50_000_000, appliedTermDays: 1_800,
    },
    awaitingRegimeApproval: false, pendingOverrideId: null,
    entity: { id: "e-1", legalName: "Synthetic Plant (Pty) Ltd", type: "PRIVATE_COMPANY", registrationNumber: "2020/000001/07" },
    client: null,
    asset: { id: "a-1", description: "2025 Testmake Loader", serialNumber: "SN-TEST-1", cashPriceExclVatCents: 50_000_000, vatCents: 7_500_000 },
    supplier: { id: "s-1", name: "Synthetic Supplier" },
    product: { id: "p-1", name: "Synthetic Asset Product" },
    terms: {
      depositCents: 5_000_000, tradeInCents: 0, financedFeesCents: 0, balloonCents: 10_000_000, preset: "MONTHLY", weights: Array(36).fill(1),
      firstDueDate: "2026-11-01", vatDeferralPeriodIndex: null, rate: { basis: "FIXED", margin: null, fixedRate: "0.13" },
    },
    schedule: { ok: false, error: "not solved in this test" },
    leaseSchedule: null,
    financials: null, sureties: [], directorsAndTrustees: [], bureau: [], exceptions: { internalArrears: [], lines: [] },
    decision: { decision: null, reasons: [], decidedById: null, decidedAt: null },
    ...over,
  }
}

const operatingLease = (over: Partial<DealDetail> = {}) => {
  const base = deal()
  return deal({
    contractType: "OPERATING_LEASE",
    terms: {
      ...base.terms, depositCents: 0, balloonCents: 20_000_000,
      lease: { rentalTiming: "ADVANCE", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1", maintenance: null, usage: { allowancePerYear: 30_000, unit: "KM", excessRateCents: 250 } },
    },
    ...over,
  })
}

describe("asset-finance deal pages (Fair Score audit E1–E3)", () => {
  it("an operating lease's deal panel uses lease terms: agreement type, lessee, residual, no loan wording", async () => {
    const shown = await text(<DealSummaryPanel deal={operatingLease()} />)
    expect(shown).toContain("AgreementOperating lease")
    expect(shown).toContain("Lessee")
    expect(shown).toContain("Residual (not paid by the lessee)")
    expect(shown).toContain("36 monthly rentals in advance")
    expect(shown).toMatch(/30.000 km a year/)
    for (const word of ["Borrower", "Deposit", "balloon", "Financed amount", "Instalment Sale"]) expect(shown).not.toContain(word)
  })

  it("a full-maintenance lease shows its maintenance and escalation", async () => {
    const base = operatingLease()
    const fml = deal({
      contractType: "FULL_MAINTENANCE_LEASE",
      terms: { ...base.terms, lease: { ...base.terms.lease!, maintenance: { monthlyExclVatCents: 150_000, escalationRate: "0.06", riskModel: "LENDER_RISK" } } },
    })
    const shown = await text(<DealSummaryPanel deal={fml} />)
    expect(shown).toContain("AgreementFull-maintenance lease")
    expect(shown).toContain("escalating 6.00% a year")
  })

  it("a finance lease is shown as a finance lease with a lessee, an instalment sale with a borrower", async () => {
    const financeLease = await text(<DealSummaryPanel deal={deal({ contractType: "FINANCE_LEASE" })} />)
    expect(financeLease).toContain("AgreementFinance lease")
    expect(financeLease).toContain("Lessee")
    expect(financeLease).not.toContain("Borrower")
    const sale = await text(<DealSummaryPanel deal={deal()} />)
    expect(sale).toContain("AgreementInstalment sale")
    expect(sale).toContain("Borrower")
  })

  it("an NCA deal's classification explains the regulated path instead of claiming it cannot be financed", async () => {
    const nca = deal({ application: { ...deal().application, ncaRegime: "NCA", ncaClassificationRule: "TRUST_FEWER_THAN_THREE_TRUSTEES" } })
    const shown = await text(<ClassificationPanel deal={nca} />)
    expect(shown).not.toContain("Only deals the NCA does not regulate")
    expect(shown).toContain("The NCA regulates this deal")
    expect(await text(<ClassificationPanel deal={deal()} />)).not.toContain("The NCA regulates this deal")
  })

  it("E5/E6: the credit memo lists the exceptions, and approving sends the reason given for them", async () => {
    const lines = ["Synthetic Director (Director) has loan LN-TEST-0009 with this lender: Defaulted, 166 days in arrears, R 98,123.45 overdue"]
    expect(await text(<DealExceptionsNotice lines={lines} />)).toContain(lines[0])
    expect(await text(<DealExceptionsNotice lines={[]} />)).toBe("")

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<DecidePanel dealId="deal-1" exceptions={lines} />) })
    const field = (id: string) => renderer.root.find((n) => n.type === "textarea" && n.props.id === id)
    await act(async () => { field("decision-reasons").props.onChange({ target: { value: "Strong DSCR on audited AFS" } }) })
    await act(async () => { field("exception-reason").props.onChange({ target: { value: "Arrears under a signed settlement plan" } }) })
    await act(async () => { renderer.root.findAll((n) => n.type === "button").find((b) => b.children.join("").includes("Approve"))!.props.onClick() })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(JSON.parse(init.body)).toEqual({
      decision: "APPROVE", reasons: ["Strong DSCR on audited AFS"], exceptionReason: "Arrears under a signed settlement plan", exceptionsShown: lines,
    })
    vi.unstubAllGlobals()

    await act(async () => { renderer = create(<DecidePanel dealId="deal-1" />) })
    expect(renderer.root.findAll((n) => n.type === "textarea" && n.props.id === "exception-reason")).toHaveLength(0)
  })

  it("the deals list covers leases and names each deal's agreement type", async () => {
    mocks.rows = [
      { id: "d-1", status: "BOOKED", contractType: "FINANCE_LEASE", applicationReference: "AF-1", entityName: "Synthetic Trust", assetDescription: "2025 Tractor", financedAmountCents: 1, baseInstalmentCents: 1, createdAt: "2026-10-01T08:00:00.000Z" },
      { id: "d-2", status: "APPROVED", contractType: "OPERATING_LEASE", applicationReference: "AF-2", entityName: "Synthetic Plant", assetDescription: "2025 LCV", financedAmountCents: 1, baseInstalmentCents: 1, createdAt: "2026-10-01T08:00:00.000Z" },
    ]
    const shown = await text(await DealsPage())
    expect(shown).not.toContain("Instalment-sale deals for business entities")
    expect(shown).toMatch(/leases/)
    expect(shown).toContain("Finance lease")
    expect(shown).toContain("Operating lease")
  })
})
