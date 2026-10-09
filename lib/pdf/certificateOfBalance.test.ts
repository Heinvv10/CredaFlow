import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./helpers", async () => {
  const actual = await vi.importActual<typeof import("./helpers")>("./helpers")
  return { ...actual, drawText: vi.fn(actual.drawText) }
})

import { drawText } from "./helpers"
import { generateCertificateOfBalancePdf } from "./certificateOfBalance"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

beforeEach(() => { vi.clearAllMocks() })

const input = {
  lender: { legalName: ACME_LENDER.legalName, ncrNumber: ACME_LENDER.ncrNumber },
  client: { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000080" },
  loan: {
    reference: "LN-TEST-0001", startDate: new Date("2026-08-01T10:00:00+02:00"),
    maturityDate: new Date("2026-09-01T10:00:00+02:00"), principal: 200_000, totalRepayable: 216_900,
    totalPaid: 42_000, outstandingPrincipal: 174_900, arrearsAmount: 174_900, daysInArrears: 25,
    interestRatePm: 0.05,
  },
  asAt: new Date("2026-09-26T10:00:00+02:00"),
}

const texts = () => vi.mocked(drawText).mock.calls.map((call) => call[1])

describe("certificate of balance", () => {
  it("itemises principal, contractual interest and fees, each default charge, and the total to settle", async () => {
    await generateCertificateOfBalancePdf({
      ...input,
      settlement: {
        paymentsReceived: 50_000,
        interestAndFeesOutstanding: 0,
        charges: [{ label: "Default interest", amount: 8_000 }, { label: "Collection letter fee", amount: 8_200 }],
        totalToSettle: 191_100,
      },
    })
    const t = texts()
    // Cash received, not the part of it applied to the instalments.
    expect(t[t.indexOf("Total Paid to Date:") + 1]).toBe("R 500.00")
    expect(t).toContain("Outstanding Principal Balance:")
    expect(t).toContain("Interest and Fees Outstanding:")
    expect(t).toContain("Default interest Outstanding:")
    expect(t).toContain("R 80.00")
    expect(t).toContain("Collection letter fee Outstanding:")
    expect(t).toContain("Total Amount to Settle:")
    expect(t).toContain("R 1,911.00")
    expect(t.some((line) => line.includes("is R 1,911.00."))).toBe(true)
  })

  it("renders exactly as before without settlement figures", async () => {
    await generateCertificateOfBalancePdf(input)
    const t = texts()
    expect(t).not.toContain("Total Amount to Settle:")
    expect(t.some((line) => line.includes("is R 1,749.00."))).toBe(true)
  })
})
