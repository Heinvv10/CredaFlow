import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { InsuranceProductForm } from "./InsuranceProductForm"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))

// Blind review of #139: the product form still showed "Commission per policy"
// as sum assured x rate (R4,000 on R20,000 of cover at 20%). A commission is a
// share of the premium (lib/insurance/commission.ts).
describe("InsuranceProductForm commission hint", () => {
  it("shows the commission on the premium, a month", () => {
    const html = renderToStaticMarkup(
      <InsuranceProductForm
        insurers={[]}
        initial={{ id: "p1", code: "FUN-1", name: "Funeral", type: "FUNERAL_COVER", premiumAmount: 118, sumAssured: 20_000, commissionRate: 0.2, active: true, insurerId: null }}
      />,
    )
    expect(html).toContain("Commission per policy: R 23.60 a month")
    expect(html).not.toContain("4000.00")
  })
})
