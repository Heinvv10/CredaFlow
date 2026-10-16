import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { LenderIdentityError } from "@/lib/config/identity-schema"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { section129Html, section129Text } from "@/lib/email/templates/section129"
import { extractPdfTextRuns } from "./__tests__/pdf-test-utils"
import { generateSection129Pdf } from "./section129"
import { generateCertificateOfBalancePdf } from "./certificateOfBalance"
import { generateStatementPdf } from "./statement"
import { generateCreditAgreementPdfWithAnchors } from "./creditAgreement"
import { stampExecutedAgreement } from "./executed-agreement"
import { generateDebitMandatePdf } from "./debitMandate"
import { generateFaisDisclosurePdf } from "./faisDisclosure"

// Every NCA document prints the lender identity it is given and nothing else:
// no other lender's name, numbers, office, contacts or logo. And it refuses
// to render rather than print a missing or invalid identity.

const text = (pdf: Uint8Array) => extractPdfTextRuns(Buffer.from(pdf)).map((r) => r.text).join("\n")
// Image XObjects are streams, which never sit inside a compressed object
// stream, so their dictionaries are plain text in the file.
const imageCount = async (pdf: Uint8Array) => (Buffer.from(pdf).toString("latin1").match(/\/Subtype \/Image/g) ?? []).length

const client = { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000080", addressLine1: "1 Fixture Street", city: "Johannesburg" }
const asAt = new Date("2026-09-26T08:00:00.000Z")
const s129Loan = { reference: "LN-1", arrearsAmount: 166_900, outstandingPrincipal: 166_900, daysInArrears: 25 }
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
  payments: [{ createdAt: new Date("2026-09-11T08:00:00.000Z"), receivedAt: new Date("2026-09-11T08:00:00.000Z"), amount: 50_000, paymentMethod: "EFT", reference: "FNB-123", allocationStatus: "ALLOCATED" as const }],
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
const execution = {
  consumerSignature: "Thandeka Mokoena", consumerSignedAt: new Date("2026-05-20T09:30:00.000Z"),
  providerSignature: "Nomsa Dlamini", providerName: "Nomsa Dlamini", countersignedAt: new Date("2026-05-21T14:00:00.000Z"),
}
const executedParties = { clientName: "Thandeka Mokoena", clientIdNumber: "8501015000080", applicationReference: "APP-1" }

const acmeAgreement = () => generateCreditAgreementPdfWithAnchors({ ...agreementRest, variant: "agreement", lender: ACME_LENDER })

/** One entry per generator: render with a given lender, and the identity strings it must print. */
const DOCUMENTS: Array<{ name: string; render: (lender: unknown) => Promise<Uint8Array>; prints: string[] }> = [
  {
    name: "Section 129 notice",
    render: (lender) => generateSection129Pdf({ lender: lender as never, client, loan: s129Loan, noticeDate: asAt }),
    prints: [
      "Acme Lending (Pty) Ltd", "1 Main Road", "Sandton", "2196",
      "NCR NCRCP99999", "FSP 12345", "Reg. No. 2020/123456/07",
      "Email:  collections@acme-lending.example", "Phone:  +27 11 000 0001",
    ],
  },
  {
    name: "certificate of balance",
    render: (lender) => generateCertificateOfBalancePdf({ lender: lender as never, client, loan: cobLoan, asAt }),
    prints: ["Acme Lending (Pty) Ltd", "NCR Reg: NCRCP99999"],
  },
  {
    name: "statement",
    render: (lender) => generateStatementPdf({ lender: lender as never, ...statementRest }),
    prints: ["Acme Lending (Pty) Ltd", "NCR Registration: NCRCP99999"],
  },
  {
    name: "PASQ",
    render: async (lender) => (await generateCreditAgreementPdfWithAnchors({ ...agreementRest, variant: "pasq", lender: lender as never })).bytes,
    prints: ["Acme Lending (Pty) Ltd", "NCR Registration: NCRCP99999"],
  },
  {
    name: "credit agreement",
    render: async (lender) => (await generateCreditAgreementPdfWithAnchors({ ...agreementRest, variant: "agreement", lender: lender as never })).bytes,
    prints: ["Acme Lending (Pty) Ltd", "NCR Registration: NCRCP99999"],
  },
  {
    name: "executed agreement (execution page)",
    render: async (lender) => (await stampExecutedAgreement({
      agreementBytes: (await acmeAgreement()).bytes, anchors: null, execution,
      identity: { lender: lender as never, ...executedParties },
    })).bytes,
    prints: ["Credit provider: Acme Lending (Pty) Ltd (NCR reg. no. NCRCP99999)"],
  },
  {
    name: "debit mandate",
    render: (lender) => generateDebitMandatePdf({ lender: lender as never, ...mandateRest }),
    prints: ["Acme Lending (Pty) Ltd", "NCR Reg: NCRCP99999", "1 Main Road, Sandton, 2196"],
  },
  {
    name: "FAIS disclosure",
    render: (lender) => generateFaisDisclosurePdf({ lender: lender as never, ...faisRest }),
    prints: [
      "FSP: Acme Lending (Pty) Ltd", "FSP No.: 12345", "NCR Reg.: NCRCP99999",
      "   Acme Lending (Pty) Ltd is authorised to render intermediary services",
    ],
  },
]

describe.each(DOCUMENTS)("$name", ({ render, prints }) => {
  it("prints the given lender's identity and no other lender's", async () => {
    const t = text(await render(ACME_LENDER))
    for (const value of prints) expect(t).toContain(value)
    expectNoOtherLender(t)
  })

  it("embeds no logo when none is given", async () => {
    // The executed agreement's body is the agreement, rendered without a logo above.
    expect(await imageCount(await render(ACME_LENDER))).toBe(0)
  })

  it("refuses to render without a lender identity", async () => {
    await expect(render(undefined)).rejects.toThrow(LenderIdentityError)
    await expect(render({})).rejects.toThrow(LenderIdentityError)
  })

  it("refuses an invalid NCR number rather than print it", async () => {
    await expect(render({ ...ACME_LENDER, ncrNumber: "NCRCP-1" })).rejects.toThrow(LenderIdentityError)
  })

  it("refuses an invalid legal name rather than print it", async () => {
    await expect(render({ ...ACME_LENDER, legalName: "Acme\u0000Lending" })).rejects.toThrow(LenderIdentityError)
  })
})

describe("documents that print more than name and NCR refuse each missing field", () => {
  it.each(["fspNumber", "companyRegNumber", "registeredOfficeLines", "collectionsEmail", "collectionsPhone"] as const)(
    "Section 129 notice without %s",
    async (field) => {
      await expect(generateSection129Pdf({ lender: { ...ACME_LENDER, [field]: undefined }, client, loan: s129Loan, noticeDate: asAt }))
        .rejects.toThrow(LenderIdentityError)
    },
  )

  it("Section 129 notice and FAIS disclosure for a lender with no FSP number (null)", async () => {
    const lender = { ...ACME_LENDER, fspNumber: null }
    await expect(generateSection129Pdf({ lender, client, loan: s129Loan, noticeDate: asAt })).rejects.toThrow(LenderIdentityError)
    await expect(generateFaisDisclosurePdf({ lender, ...faisRest })).rejects.toThrow(LenderIdentityError)
  })

  it("debit mandate without a registered office", async () => {
    await expect(generateDebitMandatePdf({ lender: { ...ACME_LENDER, registeredOfficeLines: [] }, ...mandateRest }))
      .rejects.toThrow(LenderIdentityError)
  })

  it("FAIS disclosure without an FSP licence number", async () => {
    await expect(generateFaisDisclosurePdf({ lender: { ...ACME_LENDER, fspNumber: undefined as never }, ...faisRest }))
      .rejects.toThrow(LenderIdentityError)
  })

  it("execution page without any identity", async () => {
    const { bytes } = await acmeAgreement()
    await expect(stampExecutedAgreement({ agreementBytes: bytes, anchors: null, execution }))
      .rejects.toThrow(LenderIdentityError)
  })
})

describe("Section 129 notice, optional identity", () => {
  it("prints the second collections number and the tagline only when set", async () => {
    const without = text(await generateSection129Pdf({ lender: ACME_LENDER, client, loan: s129Loan, noticeDate: asAt }))
    expect(without).toContain("Phone:  +27 11 000 0001")
    expect(without).not.toContain("+27 11 000 0001    /")
    const withBoth = text(await generateSection129Pdf({
      lender: { ...ACME_LENDER, collectionsPhoneSecondary: "+27 82 000 0002", brandTagline: "Credit made simple" },
      client, loan: s129Loan, noticeDate: asAt,
    }))
    expect(withBoth).toContain("Phone:  +27 11 000 0001    /    +27 82 000 0002")
    expect(withBoth).toContain("Credit made simple")
  })
})

describe("Section 129 text letterhead with a long legal name", () => {
  // Each drawn run with its font size: pdf-lib emits "/Fn <size> Tf" before every run.
  function sizedRuns(pdf: Uint8Array) {
    const runs: { size: number; x: number; y: number; text: string }[] = []
    const raw = Buffer.from(pdf)
    let i = 0
    while ((i = raw.indexOf("stream", i)) !== -1) {
      let start = i + 6
      while (raw[start] === 13 || raw[start] === 10) start++
      const end = raw.indexOf("endstream", start)
      i = end + 9
      let body: string
      try { body = inflateSync(raw.subarray(start, end)).toString("latin1") } catch { continue }
      for (const m of body.matchAll(/\/\S+ ([\d.]+) Tf[^<]*?1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\s*<([0-9A-Fa-f]+)> Tj/g)) {
        runs.push({ size: Number(m[1]), x: Number(m[2]), y: Number(m[3]), text: Buffer.from(m[4], "hex").toString("latin1") })
      }
    }
    return runs
  }

  it("never draws the name over the registered office block", async () => {
    const bold = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold)
    const lender = {
      ...ACME_LENDER,
      legalName: "Testlandia Community Microfinance and Development Lenders (Pty) Ltd",
      registeredOfficeLines: ["Unit 12, Block C, The Sample Office Park", "1066 Fixture Street, Testveld", "Pretoria", "0083"],
      brandTagline: "Credit for the community, from the community",
    }
    const runs = sizedRuns(await generateSection129Pdf({ lender, client, loan: s129Loan, noticeDate: asAt }))
    const office = runs.filter((r) => lender.registeredOfficeLines.includes(r.text))
    expect(office).toHaveLength(4)
    const officeLeft = Math.min(...office.map((r) => r.x))
    const officeBottom = Math.min(...office.map((r) => r.y))
    const nameRuns = runs.filter((r) => r.x === 40 && r.y > officeBottom - 12 && !lender.registeredOfficeLines.includes(r.text))
    expect(nameRuns.map((r) => r.text).join(" ")).toContain(lender.legalName)
    for (const r of nameRuns.filter((n) => n.text !== lender.brandTagline)) {
      expect(r.x + bold.widthOfTextAtSize(r.text, r.size)).toBeLessThan(officeLeft)
    }
  })

  it("refuses a tagline word too wide to fit beside the office rather than print over it", async () => {
    const lender = {
      ...ACME_LENDER,
      brandTagline: "Supercalifragilisticexpialidocious-microlending-solutions",
      registeredOfficeLines: [
        "Suite 1201, Twelfth Floor, Example City Office Towers, 83 Example Rd, Testhurst",
        "Sandton",
        "Corner Example Road and Fifth Street, Sampled Village, Sandton Central 2196",
      ],
    }
    await expect(generateSection129Pdf({ lender, client, loan: s129Loan, noticeDate: asAt })).rejects.toThrow(LenderIdentityError)
  })

  it("keeps the approved layout for a name that fits", async () => {
    const runs = sizedRuns(await generateSection129Pdf({ lender: ACME_LENDER, client, loan: s129Loan, noticeDate: asAt }))
    expect(runs.find((r) => r.text === "Acme Lending (Pty) Ltd" && r.x === 40)).toMatchObject({ size: 16 })
  })
})

describe("letterhead logo seam", () => {
  // A 1x1 PNG: the seam takes any tenant's logo bytes.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

  it("embeds the logo it is given in place of the text header", async () => {
    const pdf = await generateSection129Pdf({ lender: ACME_LENDER, logo: png, client, loan: s129Loan, noticeDate: asAt })
    expect(await imageCount(pdf)).toBeGreaterThan(0) // an RGBA PNG embeds as image + alpha mask
  })
})

describe("FAIS clause 2 with a long legal name", () => {
  it("wraps inside the approved block's line width instead of running off the page", async () => {
    const legalName = "Acme Lending and Very Long Registered Credit Provider Holdings (Pty) Ltd"
    const runs = extractPdfTextRuns(Buffer.from(await generateFaisDisclosurePdf({ lender: { ...ACME_LENDER, legalName }, ...faisRest })))
    const flowed = runs.map((r) => r.text.trim()).join(" ")
    expect(flowed).toContain(`${legalName} is authorised to render intermediary services in the product categories`)
    for (const run of runs) expect(run.text.length).toBeLessThanOrEqual(78)
  })
})

describe("Section 129 covering email", () => {
  const data = { clientName: "Thandi Mthembu", loanReference: "LN-1", arrearsAmount: 166_900, outstandingBalance: 166_900, daysInArrears: 25, noticeDate: "26 September 2026" }

  // Whole phrases, so a value printed in another value's slot fails.
  it.each([
    ["html", section129Html, [
      "<h1>Acme Lending (Pty) Ltd</h1>",
      "Registered Credit Provider — NCR NCRCP99999 &nbsp;·&nbsp; Authorised FSP 12345",
      "your credit agreement with Acme Lending (Pty) Ltd is in default.",
      '<b>Email:</b> <a href="mailto:collections@acme-lending.example">collections@acme-lending.example</a>',
      "<b>Phone:</b> +27 11 000 0001\n",
      "within 10 business days, Acme Lending (Pty) Ltd reserves the right",
      "<b>Collections Department</b><br>\n  Acme Lending (Pty) Ltd</p>",
      "contact us immediately at collections@acme-lending.example.",
      "Acme Lending (Pty) Ltd is a Registered Credit Provider (NCR NCRCP99999) and an Authorised Financial Services Provider (FSP 12345).",
    ]],
    ["text", section129Text, [
      "SECTION 129 NOTICE — ACME LENDING (PTY) LTD\nNCR Registration: NCRCP99999\n",
      "your credit agreement with Acme Lending (Pty) Ltd\nis in default.",
      "  Email: collections@acme-lending.example\n  Phone: +27 11 000 0001\n",
      "within 10 business days, Acme Lending (Pty) Ltd\nreserves the right",
      "Collections Department\nAcme Lending (Pty) Ltd\nNCR NCRCP99999 · FSP 12345",
    ]],
  ] as const)("%s prints the given lender's identity, each value in its place, and no other lender's", (_, render, phrases) => {
    const body = render({ ...data, lender: ACME_LENDER })
    for (const phrase of phrases) expect(body).toContain(phrase)
    expectNoOtherLender(body)
  })

  it.each([["html", section129Html], ["text", section129Text]] as const)("%s refuses a missing or invalid identity", (_, render) => {
    expect(() => render({ ...data, lender: undefined as never })).toThrow(LenderIdentityError)
    expect(() => render({ ...data, lender: { ...ACME_LENDER, ncrNumber: "NCRCP99999x" } })).toThrow(LenderIdentityError)
    expect(() => render({ ...data, lender: { ...ACME_LENDER, collectionsEmail: "x" } })).toThrow(LenderIdentityError)
  })

  // An FSP number is optional in the identity (§2a.2), but the notice prints
  // one: until its wording is approved without the FSP line, a lender without
  // one is refused, never shown "FSP null".
  it.each([["html", section129Html], ["text", section129Text]] as const)("%s refuses a lender with no FSP number", (_, render) => {
    expect(() => render({ ...data, lender: { ...ACME_LENDER, fspNumber: null } })).toThrow(LenderIdentityError)
  })

  it("escapes identity values in the HTML body", () => {
    const html = section129Html({ ...data, lender: { ...ACME_LENDER, legalName: "Smith & <Sons> (Pty) Ltd" } })
    expect(html).toContain("Smith &amp; &lt;Sons&gt; (Pty) Ltd")
    expect(html).not.toContain("<Sons>")
  })

  it("prints the tagline and second number only when set", () => {
    const plain = section129Html({ ...data, lender: ACME_LENDER })
    expect(plain).not.toContain('class="tagline"')
    const full = section129Html({ ...data, lender: { ...ACME_LENDER, brandTagline: "Credit made simple", collectionsPhoneSecondary: "+27 82 000 0002" } })
    expect(full).toContain('<div class="tagline">Credit made simple</div>')
    expect(full).toContain("+27 11 000 0001 &nbsp;/&nbsp; +27 82 000 0002")
  })
})
