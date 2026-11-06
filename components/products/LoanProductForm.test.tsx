import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { LoanProductForm } from "./LoanProductForm"
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }))
const initial = { code: "SYNTH", name: "Synthetic", productType: "PERSONAL" as const, minAmount: 10000, maxAmount: 50000, minTermDays: 365, maxTermDays: 365, interestRatePm: 3, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, active: true }
describe("Product interest guidance", () => {
  it("does not certify a 3% unsecured product when the approval helper refuses it", () => {
    const html = renderToStaticMarkup(<LoanProductForm initial={initial} interestBasis={{ day: "2026-10-17", repo: { rate: 0.0825, approved: 0.0825 } }} />)
    expect(html).not.toContain("Within NCA cap")
    expect(html).toContain("29.25%")
    expect(html).toContain("unsecured credit transaction")
    expect(html).toContain("2026-10-17")
    expect(html).toContain("Illustrative transaction only")
  })
})

describe("the regulator's product approval reference", () => {
  afterEach(() => resetActiveJurisdiction())
  const render = () => renderToStaticMarkup(<LoanProductForm initial={{ ...initial, regulatorApprovalRef: "CBK/DEMO/0001" }} interestBasis={{ day: "2026-10-17", repo: { rate: 0.0825, approved: 0.0825 } }} />)

  it("is asked of a Kenyan lender, named as the CBK product approval reference", () => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    const html = render()
    expect(html).toContain('id="product-regulator-approval-ref"')
    expect(html).toContain("Central Bank of Kenya (CBK) product approval reference")
    expect(html).toContain('value="CBK/DEMO/0001"')
  })

  it("is not shown to a South African (NCA) lender", () => {
    expect(render()).not.toContain("product-regulator-approval-ref")
  })
})
