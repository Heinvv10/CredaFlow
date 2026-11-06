import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { MpesaPaymentPanel } from "./MpesaPaymentPanel"
import type { LoanOption } from "./StitchPaymentForm"

const loan: LoanOption = {
  id: "l1", reference: "NRB-LN-1", outstandingPrincipal: 100_000, nextInstallment: 120_050,
  settlementAmount: 200_000, paymentDefault: 120_050, chargeLines: [],
}
const render = (stkPush: boolean, loans = [loan]) =>
  renderToStaticMarkup(<MpesaPaymentPanel paybill="600100" loans={loans} stkPush={stkPush} phone="0712345678" />)

describe("MpesaPaymentPanel", () => {
  it("shows the paybill number and the loan reference as the account number", () => {
    const html = render(false)
    expect(html).toContain("600100")
    expect(html).toContain("NRB-LN-1")
    expect(html).not.toContain("<form")
  })

  it("offers Pay with M-Pesa, in whole shillings, only where the push may run", () => {
    const html = render(true)
    expect(html).toContain("<form")
    expect(html).toContain('value="1201"')
    expect(html).toContain('value="0712345678"')
  })

  it("renders nothing without a loan to pay", () => {
    expect(render(true, [])).toBe("")
  })
})
