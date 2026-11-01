import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { ApplicationApprovePanel } from "@/components/applications/ApplicationApprovePanel"
import { PaymentForm } from "@/components/loans/PaymentForm"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"

const payment = () => renderToStaticMarkup(<PaymentForm {...({ loanId: "l1", settlementAmount: 100_000, contractualBalance: 120_000, loanStartDate: "2026-01-01" } as unknown as Parameters<typeof PaymentForm>[0])} />)
const panel = (keyFacts: boolean) => renderToStaticMarkup(<ApplicationApprovePanel applicationId="a1" canApprove openChecks={0} keyFacts={keyFacts} />)

describe("a key-facts screen says nothing South African, and a South African one is as it was", () => {
  afterEach(() => resetActiveJurisdiction())

  it("the payment form names the lender's currency and no NCA section", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(payment()).toContain("Payment Amount (M)")
    expect(payment()).not.toContain("s125")
    resetActiveJurisdiction()
    setActiveJurisdiction({ jurisdiction: "ZA", currency: "ZAR" })
    expect(payment()).toContain("Payment Amount (R)")
    expect(payment()).toContain("NCA s125")
  })

  it("the approval panel offers no debit order on a key-facts application, and EFT is chosen", () => {
    expect(panel(true)).not.toContain("Debit order")
    expect(panel(true)).toMatch(/checked=""[^>]*value="EFT"|value="EFT"[^>]*checked=""/)
    expect(panel(false)).toContain("Debit order")
  })
})
