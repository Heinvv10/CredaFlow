import { afterEach, describe, expect, it } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { LenderIdentityError } from "@/lib/config/identity-schema"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { boundaryStatementInput } from "@/scripts/nca-pdf-fingerprint"
import { generateCertificateOfBalancePdf } from "../certificateOfBalance"
import { generateDebitMandatePdf } from "../debitMandate"
import { generateStatementPdf } from "../statement"
import { extractPdfTextRuns } from "./pdf-test-utils"

// A lender outside the NCA has no NCR number. Its statement, certificate of balance and debit mandate carry the company
// registration number and cite no South African statute; the same documents for a South African lender are pinned elsewhere
// (charges-off-identity.test.ts, scripts/nca-pdf-fingerprint.ts) and must not move.
const LS_LENDER = { legalName: "Demo Basotho Lending (Pty) Ltd", ncrNumber: null, companyRegNumber: "2099/000001", registeredOfficeLines: ["1 Demo Road", "Maseru", "100"] }
const text = (buf: Buffer) => extractPdfTextRuns(buf).map((r) => r.text).join("\n")
const SA_ONLY = /NCR|National Credit Act|section 112|PASA|Payment Association/i

afterEach(() => resetActiveJurisdiction())

const cob = {
  client: { firstName: "Thabo", lastName: "Synthetic", idNumber: "990000001" },
  loan: { reference: "LN-LS-0001", startDate: new Date("2026-10-01"), maturityDate: new Date("2027-03-31"), principal: 500000, totalRepayable: 560000, totalPaid: 0, outstandingPrincipal: 500000, arrearsAmount: 0, daysInArrears: 0, interestRatePm: 0.05 },
}

describe("certificate of balance", () => {
  it("renders for a lender with no NCR number: the company registration number, no NCR line, no section 112", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const printed = text(await generateCertificateOfBalancePdf({ ...cob, lender: LS_LENDER }))
    expect(printed).toContain("Registration no.: 2099/000001")
    expect(printed).toContain("Registration No.")
    expect(printed).toContain("M 5,000.00")
    expect(printed).not.toMatch(SA_ONLY)
  })

  it("speaks of a borrower and a loan agreement, and leaves the legal wording to the bank's legal team", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const printed = text(await generateCertificateOfBalancePdf({ ...cob, lender: LS_LENDER }))
    for (const word of ["Consumer", "CREDIT AGREEMENT", "credit agreement", "credit provider"]) expect(printed).not.toContain(word)
    expect(printed).toContain("Borrower ID")
    expect(printed).toContain("LOAN AGREEMENT DETAILS")
    expect(printed).toMatch(/\[SAMPLE:/)
  })

  it("still refuses a South African lender with no NCR number, and still prints its NCR line and section 112", async () => {
    await expect(generateCertificateOfBalancePdf({ ...cob, lender: LS_LENDER })).rejects.toBeInstanceOf(LenderIdentityError)
    const printed = text(await generateCertificateOfBalancePdf({ ...cob, lender: { legalName: ACME_LENDER.legalName, ncrNumber: ACME_LENDER.ncrNumber } }))
    expect(printed).toContain(`NCR Reg: ${ACME_LENDER.ncrNumber}`)
    expect(printed).toContain("section 112 of the National Credit Act")
    expect(printed).toContain("Consumer ID")
    expect(printed).toContain("CREDIT AGREEMENT DETAILS")
    expect(printed).not.toContain("SAMPLE")
  })

  it("refuses a Lesotho lender with no company registration number rather than print a blank", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await expect(generateCertificateOfBalancePdf({ ...cob, lender: { ...LS_LENDER, companyRegNumber: null } as never })).rejects.toBeInstanceOf(LenderIdentityError)
  })
})

describe("loan account statement", () => {
  it("renders for a lender with no NCR number and prints no NCR line", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const input = boundaryStatementInput(2, 2)
    const printed = text(await generateStatementPdf({ ...input, lender: LS_LENDER }))
    expect(printed).toContain("Registration no.: 2099/000001")
    expect(printed).not.toMatch(/NCR|National Credit Act/i)
  })

  it("a South African lender's statement still prints its NCR registration", async () => {
    const input = boundaryStatementInput(2, 2)
    expect(text(await generateStatementPdf(input))).toMatch(/NCR Registration: /)
  })
})

describe("debit mandate", () => {
  const mandate = {
    lender: LS_LENDER,
    creditorBank: { bankName: "Provider Bank", accountNumber: "9876543210", branchCode: "250655" },
    client: { firstName: "Synthetic", lastName: "Customer", idNumber: "990000001", bankName: "Test Bank", branchCode: "000001", accountNumber: "1234567890", accountType: "CHEQUE" as const },
    loan: { reference: "LN-LS-1", paymentFrequency: "MONTHLY" as const, recurringDebitAmount: 232_945, firstDebitAmount: 266_165, firstDebitInitiationFee: 33_220, firstDebitDate: new Date("2026-11-01T00:00:00.000Z"), repaymentDayOfMonth: 1 },
    generatedAt: new Date("2026-10-22T08:00:00.000Z"),
  }

  it("names a creditor with no NCR number by its company registration, and cites no South African statute or payment body", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const printed = text(await generateDebitMandatePdf(mandate))
    expect(printed).toContain("Registration no.: 2099/000001")
    const hit = printed.split("\n").filter((l) => SA_ONLY.test(l))
    expect(hit).toEqual([])
  })
})
