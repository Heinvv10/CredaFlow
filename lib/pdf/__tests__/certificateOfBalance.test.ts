import { describe, expect, it } from "vitest"
import { LenderIdentityError } from "../../config/identity-schema"
import { generateCertificateOfBalancePdf } from "../certificateOfBalance"
import { extractPdfTextRuns } from "./pdf-test-utils"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const ONE_PX_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
)

const fixture = {
  lender: { legalName: ACME_LENDER.legalName, ncrNumber: ACME_LENDER.ncrNumber },
  client: { firstName: "Johannes", lastName: "Tester", idNumber: "6901015000089" },
  loan: {
    reference: "LN-TEST-0001",
    startDate: new Date("2026-07-22"),
    maturityDate: new Date("2026-08-21"),
    principal: 200000,
    totalRepayable: 247000,
    totalPaid: 0,
    outstandingPrincipal: 200000,
    arrearsAmount: 0,
    daysInArrears: 0,
    interestRatePm: 5,
  },
}

describe("generateCertificateOfBalancePdf — header layout", () => {
  it("renders a non-empty PDF starting with the PDF magic bytes", async () => {
    const buf = await generateCertificateOfBalancePdf(fixture)
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF")
  })

  it("falls back to a text-only header without overlapping lines when no logo is passed", async () => {
    const buf = await generateCertificateOfBalancePdf(fixture)
    const runs = extractPdfTextRuns(buf)

    const nameRun = runs.find((r) => r.text === fixture.lender.legalName)
    const ncrRun = runs.find((r) => r.text === `NCR Reg: ${fixture.lender.ncrNumber}`)
    expect(nameRun).toBeDefined()
    expect(ncrRun).toBeDefined()
    // The regression this guards: both lines must NOT share the same (x, y) —
    // that renders one on top of the other, illegible, when the chip-based
    // header can't be drawn because there is no logo.
    expect(`${nameRun!.x},${nameRun!.y}`).not.toBe(`${ncrRun!.x},${ncrRun!.y}`)
  })

  it("draws the logo-chip header (NCR line beside the chip, legal name not in the header) when a PNG logo is passed", async () => {
    const buf = await generateCertificateOfBalancePdf({ ...fixture, logo: ONE_PX_PNG })
    const runs = extractPdfTextRuns(buf)
    const ncrRun = runs.find((r) => r.text === `NCR Reg: ${fixture.lender.ncrNumber}`)
    expect(ncrRun).toBeDefined()
    const textHeader = extractPdfTextRuns(await generateCertificateOfBalancePdf(fixture)).find((r) => r.text === `NCR Reg: ${fixture.lender.ncrNumber}`)
    // Logo path indents the NCR line past the chip; the text-header path starts at the margin.
    expect(ncrRun!.x).toBeGreaterThan(textHeader!.x)
  })

  it("throws LenderIdentityError when the NCR number is invalid", async () => {
    await expect(
      generateCertificateOfBalancePdf({ ...fixture, lender: { ...fixture.lender, ncrNumber: "pending" } }),
    ).rejects.toBeInstanceOf(LenderIdentityError)
  })
})
