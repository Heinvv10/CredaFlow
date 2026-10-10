import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ChargesPanel } from "./ChargesPanel"
import type { LoanChargesView } from "@/lib/loan/charges-summary"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const charges: LoanChargesView = {
  buckets: {
    DEFAULT_INTEREST: { accrued: 9_667, paid: 2_000, outstanding: 7_667 },
    SERVICE_FEE: { accrued: 6_900, paid: 0, outstanding: 6_900 },
    DEFAULT_ADMIN: { accrued: 8_200, paid: 8_200, outstanding: 0 },
  },
  outstanding: 14_567,
  postings: [
    { type: "DEFAULT_INTEREST", day: "2026-09-30", amount: 9_667 },
    { type: "DEFAULT_ADMIN", day: "2026-10-01", amount: 8_200, sourceId: "s129-abc" },
    { type: "SERVICE_FEE", day: "2026-10-01", amount: 6_900 },
  ],
  inDuplum: { capBase: 200_000, accrued: 24_767, reached: false },
  goLive: new Date("2026-09-26T10:00:00+02:00"),
  accrueFrom: new Date("2026-09-02T12:00:00+02:00"),
  exempt: false,
  exemptReason: null,
}

const render = (over: Partial<Parameters<typeof ChargesPanel>[0]> = {}) => renderToStaticMarkup(
  <ChargesPanel loanId="loan-1" charges={charges} waivable={false} settlementAmount={230_000} canManage chargesNotDerived={null} {...over} />,
)

describe("ChargesPanel", () => {
  it("shows each charge type with accrued, paid and outstanding, and the postings", () => {
    const html = render()
    expect(html).toContain("Default interest")
    expect(html).toContain("Service fee after due date")
    expect(html).toContain("Collection letter fee")
    expect(html).toContain("R 76.67")
    expect(html).toContain("R 145.67")
    expect(html).toContain("30 Sept 2026")
    expect(html).toContain("s129-abc")
  })

  it("shows the in duplum position and the dates charging started", () => {
    const html = render()
    expect(html).toContain("R 247.67")
    expect(html).toContain("R 2,000.00")
    expect(html).toContain("26 Sept 2026")
    expect(html).toContain("02 Sept 2026")
  })

  it("offers the small-balance waiver only when the settlement is waivable", () => {
    expect(render()).not.toContain("Waive balance")
    expect(render({ waivable: true, settlementAmount: 75 })).toContain("Waive balance")
  })

  it("shows an exemption and its reason, and hides actions from staff who cannot manage them", () => {
    const html = render({ charges: { ...charges, exempt: true, exemptReason: "Rounding residue only", accrueFrom: null } })
    expect(html).toContain("Exempt")
    expect(html).toContain("Rounding residue only")
    expect(render({ canManage: false })).not.toContain("Exempt this loan")
  })

  it("renders the waiver alone when charges are off for the tenant", () => {
    const html = render({ charges: null, waivable: true, settlementAmount: 75 })
    expect(html).toContain("Waive balance")
    expect(html).not.toContain("Default interest")
  })

  it("warns staff when the latest Section 129 notice's charge could not be posted", () => {
    const html = render({ charges: null, chargesNotDerived: "Default charges would re-open this settled loan" })
    expect(html).toContain("The latest Section 129 notice was recorded, but its admin charge was not posted")
    expect(html).toContain("Default charges would re-open this settled loan")
    expect(render()).not.toContain("was not posted")
  })
})
