import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { DisburseForm, PAYMENT_REFERENCE_PLACEHOLDER } from "./DisburseForm"

const props = {
  applicationId: "app-1",
  repaymentMethod: "DEBIT_ORDER" as const,
  principalCents: 3_000_000,
  disbursementCents: 3_000_000,
  clientName: "Synthetic Client",
  clientBankDetails: { bankName: "Nedbank", bankAccountNumber: "1234567890", bankBranchCode: "198765", accountType: "CHEQUE" },
}

describe("DisburseForm", () => {
  it("renders as one full-width rail button until opened", () => {
    const html = renderToStaticMarkup(<DisburseForm {...props} />)
    expect(html).toContain("Disburse Loan")
    expect(html).toMatch(/<button[^>]*class="[^"]*w-full/)
    expect(html).not.toContain("Payment Reference")
  })

  // Fair Score audit 2026-10-16: the placeholder showed a stale April date.
  it("suggests no dated example reference", () => {
    expect(PAYMENT_REFERENCE_PLACEHOLDER).not.toMatch(/\d{8}/)
    expect(PAYMENT_REFERENCE_PLACEHOLDER).not.toContain("DISB-2026")
  })
})
