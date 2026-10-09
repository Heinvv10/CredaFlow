import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./helpers", async () => {
  const actual = await vi.importActual<typeof import("./helpers")>("./helpers")
  return { ...actual, drawText: vi.fn(actual.drawText) }
})

import { drawText } from "./helpers"
import { generateSection129Pdf } from "./section129"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

beforeEach(() => { vi.clearAllMocks() })

const base = {
  lender: ACME_LENDER,
  client: { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000080" },
  noticeDate: new Date("2026-09-26T10:00:00+02:00"),
}
// Joined with spaces: wrapped statutory paragraphs break only between words.
const texts = () => vi.mocked(drawText).mock.calls.map((call) => call[1]).join(" ")

describe("Section 129 notice amounts", () => {
  it("states the full charge-inclusive obligation and arrears, and names the charges included", async () => {
    await generateSection129Pdf({
      ...base,
      loan: {
        reference: "LN-1", arrearsAmount: 182_900, outstandingPrincipal: 174_900, daysInArrears: 25,
        totalOutstanding: 191_100, chargesOutstanding: 16_200,
      },
    })
    const t = texts()
    expect(t).toContain("in arrears in the amount of R 1,829.00.")
    expect(t).toContain("Your total outstanding obligation is R 1,911.00.")
    expect(t).toContain("Default Charges (included above):")
    expect(t).toContain("R 162.00")
  })

  it("renders exactly as before when no charge-inclusive figures are supplied", async () => {
    await generateSection129Pdf({
      ...base,
      loan: { reference: "LN-1", arrearsAmount: 174_900, outstandingPrincipal: 174_900, daysInArrears: 25 },
    })
    const t = texts()
    expect(t).toContain("Your total outstanding obligation is R 1,749.00.")
    expect(t).not.toContain("Default Charges")
  })
})
