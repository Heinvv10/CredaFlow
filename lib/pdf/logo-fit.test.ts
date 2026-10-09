import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { makePng } from "@/lib/config/__fixtures__/png"
import { extractPdfTextRuns } from "./__tests__/pdf-test-utils"
import { A4_WIDTH, MARGIN, fitLogo } from "./helpers"
import { generateSection129Pdf } from "./section129"
import { generateCertificateOfBalancePdf } from "./certificateOfBalance"
import { generateStatementPdf } from "./statement"
import { generateCreditAgreementPdfWithAnchors } from "./creditAgreement"
import { generateDebitMandatePdf } from "./debitMandate"
import { generateFaisDisclosurePdf } from "./faisDisclosure"

// A tenant uploads its own letterhead logo (lib/config/lender-logo.ts), of any
// shape the upload accepts. Whatever its shape, it must print inside the room
// the letterhead has: never over the registered office, never over the header
// text beside it and never off the page. The text letterhead (no logo) is
// pinned elsewhere and is not touched by any of this.

const WIDE = makePng(1600, 200) // 8:1, the widest the upload accepts
const MODERATE = makePng(1400, 200) // 7:1
const LONG_OFFICE = { ...ACME_LENDER, registeredOfficeLines: ["Unit 12, The Very Long Business Park Building, 123 Long Industrial Road", "Sandton", "2196"] }

/** Every image draw on the first page: its box in page coordinates. */
function imageBoxes(pdf: Uint8Array): { x: number; y: number; width: number; height: number }[] {
  const s = Buffer.from(pdf).toString("latin1")
  const boxes: { x: number; y: number; width: number; height: number }[] = []
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let text: string
    try {
      text = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1")
    } catch {
      continue
    }
    for (const d of text.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) cm\n1 0 0 1 0 0 cm\n([\d.]+) 0 0 ([\d.]+) 0 0 cm\n1 0 0 1 0 0 cm\n\/Image-\d+ Do/g)) {
      boxes.push({ x: Number(d[1]), y: Number(d[2]), width: Number(d[3]), height: Number(d[4]) })
    }
  }
  return boxes
}

const client = { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000080", addressLine1: "1 Fixture Street", city: "Johannesburg" }
const asAt = new Date("2026-09-26T08:00:00.000Z")
const cobLoan = {
  reference: "LN-1", startDate: new Date("2026-08-01T08:00:00.000Z"), maturityDate: new Date("2026-09-01T08:00:00.000Z"),
  principal: 200_000, totalRepayable: 216_900, totalPaid: 50_000, outstandingPrincipal: 166_900, arrearsAmount: 166_900,
  daysInArrears: 25, interestRatePm: 0.05, lastPaymentDate: new Date("2026-09-11T08:00:00.000Z"), lastPaymentAmount: 50_000,
}
const statementRest = {
  client: { ...client, email: "fixture@example.invalid" },
  loan: {
    id: "fixture", reference: "LN-1", principal: 200_000, totalRepayable: 216_900, totalPaid: 50_000,
    outstandingPrincipal: 166_900, interestRatePm: 0.05, interestModel: "FLAT", status: "DEFAULTED",
    startDate: new Date("2026-08-01T08:00:00.000Z"), maturityDate: new Date("2026-09-01T08:00:00.000Z"),
    daysInArrears: 25, arrearsAmount: 166_900,
  },
  product: { name: "Micro Loan" },
  schedule: [{ installmentNo: 1, dueDate: new Date("2026-09-01T08:00:00.000Z"), totalDue: 216_900, totalPaid: 50_000, status: "PARTIAL" }],
  payments: [],
  statementDate: asAt,
}
const agreementRest = {
  client: { firstName: "Thandeka", lastName: "Mokoena", idNumber: "8501015000080", addressLine1: "45 Oak Avenue", city: "Soweto" },
  application: { reference: "APP-1", agreementType: "Short-term Credit", appliedTermDays: 30 },
  calc: {
    principal: 500000, initiationFee: 57500, totalInterest: 25000, totalRepayable: 582500, disbursementAmount: 500000,
    monthlyInstalment: 582500, serviceFees: 6900,
    schedule: [{ installmentNo: 1, dueDate: new Date("2026-06-01"), openingBalance: 500000, principalDue: 500000, interestDue: 25000, feesDue: 6900, totalDue: 582500, closingBalance: 0 }],
  },
  product: { interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6900 },
  startDate: new Date("2026-05-15"),
  maturityDate: new Date("2026-06-14"),
  quotePresentedAt: new Date("2026-05-15T08:00:00.000Z"),
  quoteValidUntilDate: "2026-05-22",
}
const mandateRest = {
  creditorBank: { bankName: "Provider Bank", accountNumber: "9876543210", branchCode: "250655" },
  client: { firstName: "Synthetic", lastName: "Customer", idNumber: "9001015009087", bankName: "Test Bank", branchCode: "000001", accountNumber: "1234567890", accountType: "CHEQUE" as const },
  loan: { reference: "LN-1", paymentFrequency: "MONTHLY" as const, recurringDebitAmount: 232_945, firstDebitAmount: 266_165, firstDebitInitiationFee: 33_220, firstDebitDate: new Date("2026-08-01T00:00:00.000Z"), repaymentDayOfMonth: 1 },
  generatedAt: new Date("2026-07-22T08:00:00.000Z"),
}
const faisRest = {
  client: { firstName: "Thandeka", lastName: "Mokoena", idNumber: "8501015000080" },
  advisor: { name: "Bongani Zulu", designation: "Insurance Officer" },
  product: { type: "FUNERAL_COVER", name: "Family Funeral Cover", insurer: "Test Life Ltd" },
  policyDraft: { sumAssured: 50000, premiumAmount: 420, term: "12 months" },
  issuedAt: asAt,
}

async function helvetica() {
  return (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)
}

describe("fitLogo", () => {
  it("keeps the target height when the logo fits, and scales it down, keeping its shape, when it does not", () => {
    expect(fitLogo({ width: 300, height: 100 }, 30, 200)).toEqual({ width: 90, height: 30 })
    expect(fitLogo({ width: 1600, height: 200 }, 56, 224)).toEqual({ width: 224, height: 28 })
  })
})

describe("a tenant logo on the Section 129 letterhead", () => {
  it.each([["8:1", WIDE], ["7:1", MODERATE]] as const)("a %s logo stops short of a long registered office", async (_shape, png) => {
    const pdf = await generateSection129Pdf({ lender: LONG_OFFICE, logo: png, client, loan: { reference: "LN-1", arrearsAmount: 1, outstandingPrincipal: 1, daysInArrears: 95 }, noticeDate: asAt })
    const [logo] = imageBoxes(pdf)
    expect(logo).toBeDefined()
    const officeLeft = Math.min(...extractPdfTextRuns(Buffer.from(pdf))
      .filter((r) => LONG_OFFICE.registeredOfficeLines.includes(r.text) && r.y > logo.y).map((r) => r.x))
    expect(logo.x + logo.width).toBeLessThanOrEqual(officeLeft - 12 + 0.01)
  })
})

describe("a tenant logo in a header bar keeps the header text on the page", () => {
  const cases = [
    ["certificate of balance", (logo: Uint8Array) => generateCertificateOfBalancePdf({ lender: ACME_LENDER, logo, client, loan: cobLoan, asAt }), "NCR Reg: NCRCP99999", 9],
    ["debit mandate", (logo: Uint8Array) => generateDebitMandatePdf({ lender: ACME_LENDER, logo, ...mandateRest }), "NCR Reg: NCRCP99999", 8],
    ["FAIS disclosure", (logo: Uint8Array) => generateFaisDisclosurePdf({ lender: ACME_LENDER, logo, ...faisRest }), "FAIS Disclosure (General Code of Conduct, sections 4, 5 + 7)", 9],
  ] as const
  it.each(cases)("%s", async (_name, render, headerText, size) => {
    const pdf = await render(WIDE)
    const [logo] = imageBoxes(pdf)
    const run = extractPdfTextRuns(Buffer.from(pdf)).find((r) => r.text === headerText)!
    expect(run).toBeDefined()
    expect(run.x).toBeGreaterThan(logo.x + logo.width)
    expect(run.x + (await helvetica()).widthOfTextAtSize(headerText, size)).toBeLessThanOrEqual(A4_WIDTH - MARGIN + 0.01)
  })
})

describe("a tenant logo above the header text stays on the page", () => {
  it.each([
    ["statement", (logo: Uint8Array) => generateStatementPdf({ lender: ACME_LENDER, logo, ...statementRest })],
    ["credit agreement", async (logo: Uint8Array) => (await generateCreditAgreementPdfWithAnchors({ ...agreementRest, variant: "agreement", lender: ACME_LENDER, logo })).bytes],
  ] as const)("%s", async (_name, render) => {
    const [logo] = imageBoxes(await render(WIDE))
    expect(logo.x + logo.width).toBeLessThanOrEqual(A4_WIDTH - MARGIN + 0.01)
  })
})
