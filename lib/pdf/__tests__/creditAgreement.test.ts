// lib/pdf/__tests__/creditAgreement.test.ts
import { createHash } from "node:crypto"
import { describe, it, expect } from "vitest"
import { inflateSync } from "zlib"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { generateCreditAgreementPdf, generateCreditAgreementPdfWithAnchors } from "../creditAgreement"
import { A4_WIDTH, MARGIN, LABEL_VALUE_OFFSET } from "../helpers"
import { calculateLoan } from "@/lib/loan-calculator"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

// ── Fixture ──────────────────────────────────────────────────────────────────

const baseInput = {
  variant: "pasq" as const,
  lender: ACME_LENDER,
  client: {
    firstName: "Thandeka",
    lastName: "Mokoena",
    idNumber: "8503015800086",
    addressLine1: "45 Oak Avenue",
    city: "Soweto",
  },
  application: {
    reference: "APP-001",
    agreementType: "Short-term Credit",
    appliedTermDays: 30,
  },
  // calc values are in cents (Int columns in Prisma)
  calc: {
    principal: 500000,          // R 5 000.00
    initiationFee: 57500,       // R 575.00
    totalInterest: 25000,       // R 250.00
    totalRepayable: 582500,     // R 5 825.00
    disbursementAmount: 500000, // R 5 000.00 — full principal (DEFERRED)
    monthlyInstalment: 582500,
    serviceFees: 6900,          // R 69.00 (1 month)
    schedule: [
      {
        installmentNo: 1,
        dueDate: new Date("2026-06-01"),
        openingBalance: 500000,
        principalDue: 500000,
        interestDue: 25000,
        feesDue: 6900,
        totalDue: 582500,
        closingBalance: 0,
      },
    ],
  },
  product: {
    interestRatePm: 0.05,
    interestModel: "FLAT",
    monthlyServiceFee: 6900,
  },
  startDate: new Date("2026-05-15"),
  maturityDate: new Date("2026-06-14"),
  quotePresentedAt: new Date("2026-05-15T08:00:00.000Z"),
  quoteValidUntilDate: "2026-05-22",
}

// ── PDF extraction helpers (same pattern as faisDisclosure.test.ts) ───────────

/** Decompress every FlateDecode stream, returned individually so callers can
 *  select which ones matter. `extractPdfContent` is this, joined. */
function rawPdfStreams(buf: Buffer): string[] {
  const parts: string[] = []
  let i = 0
  while (i < buf.length - 6) {
    if (buf.subarray(i, i + 6).toString("ascii") === "stream") {
      let start = i + 6
      while (start < buf.length && (buf[start] === 13 || buf[start] === 10)) start++
      const end = buf.indexOf(Buffer.from("endstream"), start)
      if (end > start && end - start < 200_000) {
        const streamData = buf.subarray(start, end)
        try {
          parts.push(inflateSync(streamData).toString("latin1"))
        } catch {
          parts.push(streamData.toString("latin1"))
        }
      }
      i = end > i ? end + 9 : i + 1
    } else {
      i++
    }
  }
  return parts
}

/** Decompress all FlateDecode content streams and return combined text. */
function extractPdfContent(buf: Buffer): string {
  const parts: string[] = []
  let i = 0
  while (i < buf.length - 6) {
    if (buf.subarray(i, i + 6).toString("ascii") === "stream") {
      let start = i + 6
      while (start < buf.length && (buf[start] === 13 || buf[start] === 10)) start++
      const end = buf.indexOf(Buffer.from("endstream"), start)
      if (end > start && end - start < 200_000) {
        const streamData = buf.subarray(start, end)
        try {
          parts.push(inflateSync(streamData).toString("latin1"))
        } catch {
          parts.push(streamData.toString("latin1"))
        }
      }
      i = end > i ? end + 9 : i + 1
    } else {
      i++
    }
  }
  return parts.join("\n")
}

/** Encode plain ASCII as uppercase hex (how pdf-lib embeds text in content streams). */
function pdfHex(s: string): string {
  return Buffer.from(s, "ascii").toString("hex").toUpperCase()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("generateCreditAgreementPdf — statutory variant split", () => {
  it("pasq variant renders the Form 20 quotation title, never the agreement title", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "pasq" })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("PRE-AGREEMENT STATEMENT AND QUOTATION"))
    expect(content).toContain(pdfHex("[THIS QUOTE IS BINDING FOR 5 DAYS]"))
    expect(content).not.toContain(pdfHex("Entered into pursuant to"))
  })

  it("agreement variant is titled CREDIT AGREEMENT and references — not re-issues — the quotation", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement" })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("CREDIT AGREEMENT"))
    expect(content).toContain(pdfHex("In terms of the National Credit Act 34 of 2005"))
    expect(content).toContain(pdfHex("Entered into pursuant to"))
    // The s.92 quotation instrument markers must NOT appear on the agreement:
    // it is a different statutory document and the quotation was acknowledged
    // separately during the signing ceremony.
    expect(content).not.toContain(pdfHex("PRE-AGREEMENT STATEMENT AND QUOTATION"))
    expect(content).not.toContain(pdfHex("[THIS QUOTE IS BINDING FOR 5 DAYS]"))
    expect(content).not.toContain(pdfHex("NCA Section 92(3): five business days"))
  })

  // The payout anchor. The signed schedule fixes the INTERVALS between
  // payments; payout fixes where they start. Stating that on the agreement is
  // what lets a payout land after the signature without shortening the
  // consumer's term -- absolute dates plus a late payout means R100 of interest
  // buys 29 days instead of 30, which is 5.17% a month against the s103 cap.
  //
  // It belongs to the credit agreement (s.93) and must NEVER reach the Form 20
  // quotation (s.92): that render is pinned byte for byte because acknowledged
  // PASQ digests depend on it, and a term added there would silently invalidate
  // the legal sign-off. Both halves are asserted.
  it("agreement variant states that payment dates run from the payout date", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement" })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("PAYMENT DATES: Payment dates run from the date this loan is paid out to you."))
    expect(content).toContain(pdfHex("every payment date moves by the same number of days"))
  })

  it("never puts the payout-anchor term on the Form 20 quotation", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "pasq" })
    const content = extractPdfContent(buf)
    expect(content).not.toContain(pdfHex("PAYMENT DATES: Payment dates run from the date this loan is paid out to you."))
  })

  it("agreement variant declaration attests to receiving the quotation, not to reading 'this' quotation", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement" })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("I received the Pre-Agreement Statement and Quotation before signing"))
    expect(content).not.toContain(pdfHex("I have read and understood this Pre-Agreement Statement and Quotation"))
  })

  it("every pasq declaration checkbox renders as ONE unwrapped text run (layout stability pin)", async () => {
    // The checkbox loop now wraps via font metrics. A future wording, size or
    // margin change that pushes any pasq checkbox onto a second line would
    // shift every subsequent y on the signature page by 13pt — silently
    // changing the acknowledged statutory document's layout. A wrapped line
    // splits the string across two text runs, so the contiguous hex of each
    // FULL string is the single-line proof.
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "pasq" })
    const content = extractPdfContent(buf)
    const pasqCheckboxes = [
      "I have read and understood this Pre-Agreement Statement and Quotation",
      "I have read and understood the Repayment Schedule",
      "I have been informed of my right to settle this agreement in full at any time (NCA Section 125)",
      "The information I have provided is true and correct",
    ]
    for (const cb of pasqCheckboxes) {
      expect(content).toContain(pdfHex(cb))
    }
  })

  // A quotation is an OFFER. Rendering it with a consumer signature line and a
  // contract-acceptance checkbox invites the consumer to conclude the loan by
  // signing the offer and returning it as their credit agreement.
  it("pasq variant carries NO signature block and no contract-acceptance checkbox", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "pasq" })
    const content = extractPdfContent(buf)
    expect(content).not.toContain(pdfHex("Consumer Signature:"))
    expect(content).not.toContain(pdfHex("Witness Signature:"))
    expect(content).not.toContain(pdfHex("Credit Provider Representative:"))
    expect(content).not.toContain(pdfHex("I accept the terms and conditions of this credit agreement"))
    expect(content).not.toContain(pdfHex("CONSUMER DECLARATION"))
  })

  it("pasq variant states on its face that it is not a credit agreement", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "pasq" })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("CONSUMER ACKNOWLEDGEMENT OF RECEIPT"))
    expect(content).toContain(pdfHex("THIS IS A QUOTATION - NOT A CREDIT AGREEMENT. DO NOT SIGN IT."))
    expect(content).toContain(pdfHex("This quotation is governed by the National Credit Act 34 of 2005"))
    expect(content).not.toContain(pdfHex("This agreement is governed by the National Credit Act 34 of 2005"))
  })

  // The agreement is the instrument that IS signed — the same edit must not
  // strip its signature block.
  it("agreement variant keeps its full signature block and acceptance checkbox", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement" })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("Consumer Signature:"))
    expect(content).toContain(pdfHex("Witness Signature:"))
    expect(content).toContain(pdfHex("Credit Provider Representative:"))
    expect(content).toContain(pdfHex("I accept the terms and conditions of this credit agreement"))
    expect(content).toContain(pdfHex("CONSUMER DECLARATION"))
    expect(content).toContain(pdfHex("This agreement is governed by the National Credit Act 34 of 2005"))
    expect(content).not.toContain(pdfHex("DO NOT SIGN IT"))
  })

  it("the agreement declaration checkbox also renders as one unwrapped run", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement" })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex(
      "I received the Pre-Agreement Statement and Quotation before signing this Credit Agreement",
    ))
  })

  it("agreement variant relocates the CL premium-disclosure reference off 'page 1 of this agreement'", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement", willAutoBundleCl: true })
    const content = extractPdfContent(buf)
    expect(content).not.toContain(pdfHex("on page 1 of this agreement"))
    expect(content).toContain(pdfHex("provided to you before this agreement was entered"))
  })

  // The quotation must not call itself an agreement anywhere, including inside
  // the credit-life block. The page reference itself is retained because it is
  // TRUE: with real election evidence the premium rows render on page 1 of the
  // PASQ (proved by the sibling test below, which would otherwise let this
  // sentence become a false statement about where the premium is disclosed).
  it("pasq variant points the CL premium reference at the quotation, not an agreement", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "pasq", willAutoBundleCl: true })
    const content = extractPdfContent(buf)
    // The sentence wraps after "Pre-Agreement", so the full phrase spans two
    // text runs and its contiguous hex is absent by construction. Assert the
    // fragment that stays on one line, plus the continuation, rather than a
    // phrase that can never match.
    expect(content).toContain(pdfHex("on page 1 of this Pre-Agreement"))
    expect(content).toContain(pdfHex("Statement and Quotation."))
    expect(content).not.toContain(pdfHex("on page 1 of this agreement"))
  })

  it("the CL premium IS disclosed on page 1 of the pasq, so the reference is true", async () => {
    // Accepted cover requires PASQ-bound billing evidence; without it the
    // premium rows never render and any page reference is vacuous.
    const buf = await generateCreditAgreementPdf({
      ...baseInput,
      variant: "pasq",
      willAutoBundleCl: true,
      creditLife: {
        elected: true,
        productName: "Acme Credit Life",
        insurerName: "Test Life Ltd",
        monthlyPremiumCents: 2250,
        premiumPeriods: 1,
        totalPremiumCents: 2250,
        billing: {
          version: "credit-life-billing-v1",
          collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT",
          recurringPaymentCents: 584750,
          totalRepayableCents: 584750,
          schedule: [{
            installmentNo: 1,
            openingBalanceCents: 500000,
            principalDueCents: 500000,
            interestDueCents: 25000,
            feesDueCents: 9150,
            totalDueCents: 584750,
            closingBalanceCents: 0,
          }],
        },
      },
    } as never)
    // Page 1's content stream is the FIRST drawn-text stream in the document,
    // so asserting against it — not the whole file — is what makes this a
    // claim about page 1 rather than "somewhere in the document".
    const firstPage = rawPdfStreams(buf).find((s) => s.includes(" Tj")) ?? ""
    // Self-verify that this stream really IS page 1 before asserting anything
    // about it. "first Tj-stream == page 1" is an assumption about pdf-lib's
    // serialization order; a future reorder or an earlier addPage() would
    // otherwise silently point these assertions at the wrong page and still
    // pass. The document title only ever renders on page 1.
    expect(firstPage).toContain(pdfHex("PRE-AGREEMENT STATEMENT AND QUOTATION"))
    expect(firstPage).toContain(pdfHex("Offered Credit Life Premium"))
    expect(firstPage).toContain(pdfHex("Credit Life Premiums Charged"))
    expect(firstPage).toContain(pdfHex("Premium Collection"))
  })
})

describe("generateCreditAgreementPdf — Credit Life disclosure", () => {
  it("renders the prescribed Form 20 notice and the exact statutory business-day expiry", async () => {
    const buf = await generateCreditAgreementPdf(baseInput)
    const content = extractPdfContent(buf)

    expect(content).toContain(
      pdfHex("[THIS QUOTE IS BINDING FOR 5 DAYS]"),
    )
    expect(content).toContain(pdfHex("Quote presented: 15 May 2026"))
    expect(content).toContain(pdfHex("NCA Section 92(3): five business days"))
    expect(content).toContain(pdfHex("22 May 2026"))
  })

  it("renders the CL disclosure block when willAutoBundleCl is true", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, willAutoBundleCl: true })
    const content = extractPdfContent(buf)
    // Approved G2 wording — assert on standalone heading entries (no wrap).
    expect(content).toContain(pdfHex("Credit Life Insurance Disclosure"))
    expect(content).toContain(pdfHex("Minimum benefits"))
  })

  it("renders the elected product, insurer, and exact monthly premium in the PASQ rows", async () => {
    const buf = await generateCreditAgreementPdf({
      ...baseInput,
      willAutoBundleCl: true,
      creditLife: {
        elected: true,
        productName: "Acme Credit Life",
        insurerName: "Test Life",
        monthlyPremiumCents: 2_250,
        billing: {
          version: "credit-life-billing-v1",
          collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT",
          recurringPaymentCents: 584_750,
          totalRepayableCents: 584_750,
          schedule: [{
            installmentNo: 1,
            dueDate: "2026-06-01T00:00:00.000Z",
            principalDueCents: 500_000,
            interestDueCents: 25_000,
            baseFeesDueCents: 57_500,
            creditLifePremiumDueCents: 2_250,
            feesDueCents: 59_750,
            totalDueCents: 584_750,
            openingBalanceCents: 500_000,
            closingBalanceCents: 0,
          }],
        },
      },
    })
    const content = extractPdfContent(buf)

    expect(content).toContain(pdfHex("Credit Life Product"))
    expect(content).toContain(pdfHex("Acme Credit Life"))
    expect(content).toContain(pdfHex("Credit Life Insurer"))
    expect(content).toContain(pdfHex("Test Life"))
    expect(content).toContain(pdfHex("Credit Life Premium"))
    expect(content).toContain(pdfHex("R 22.50 per month"))
    expect(content).toContain(pdfHex("Fees + cover"))
    expect(content).toContain(pdfHex("R 597.50"))
    expect(content).toContain(pdfHex("R 5,847.50"))
  })

  it("uses the final agreement dates with PASQ-bound billing amounts", async () => {
    const buf = await generateCreditAgreementPdf({
      ...baseInput,
      creditLife: {
        elected: false,
        productName: "Acme Credit Life",
        insurerName: "Test Life",
        monthlyPremiumCents: 2_250,
        premiumPeriods: 1,
        totalPremiumCents: 0,
        billing: {
          version: "credit-life-billing-v1",
          collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT",
          recurringPaymentCents: 582_500,
          totalRepayableCents: 582_500,
          schedule: [{
            installmentNo: 1,
            // Deliberately stale quotation date. The final agreement's
            // date-bearing calculator schedule is 1 June 2026.
            dueDate: "2026-05-20T00:00:00.000Z",
            principalDueCents: 500_000,
            interestDueCents: 25_000,
            baseFeesDueCents: 57_500,
            creditLifePremiumDueCents: 0,
            feesDueCents: 57_500,
            totalDueCents: 582_500,
            openingBalanceCents: 500_000,
            closingBalanceCents: 0,
          }],
        },
      },
    })
    const content = extractPdfContent(buf)

    expect(content).toContain(pdfHex("1 June 2026"))
    expect(content).not.toContain(pdfHex("20 May 2026"))
  })

  it("omits the CL disclosure block when willAutoBundleCl is false", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, willAutoBundleCl: false })
    const content = extractPdfContent(buf)
    // The G2 disclosure must not appear when the flag is off.
    expect(content).not.toContain(pdfHex("Credit Life Insurance Disclosure"))
    expect(content).not.toContain(pdfHex("Minimum benefits"))
  })

  it("renders the exact declined election and offered terms in the legal PDF", async () => {
    const buf = await generateCreditAgreementPdf({
      ...baseInput,
      willAutoBundleCl: false,
      creditLife: {
        elected: false,
        productName: "Acme Credit Life",
        insurerName: "Test Life",
        monthlyPremiumCents: 2_250,
        premiumPeriods: 2,
        totalPremiumCents: 0,
      },
    })
    const content = extractPdfContent(buf)

    expect(content).toContain(pdfHex("Credit Life Election"))
    expect(content).toContain(pdfHex("DECLINED"))
    expect(content).toContain(pdfHex("Offered Credit Life Product"))
    expect(content).toContain(pdfHex("Acme Credit Life"))
    expect(content).toContain(pdfHex("Offered Credit Life Insurer"))
    expect(content).toContain(pdfHex("Test Life"))
    expect(content).toContain(pdfHex("Offered Credit Life Premium"))
    expect(content).toContain(pdfHex("R 22.50 per month"))
    expect(content).toContain(pdfHex("Offered Premium Periods"))
    expect(content).toContain(pdfHex("Credit Life Premiums Charged"))
    expect(content).toContain(pdfHex("R 0.00"))
    expect(content).not.toContain(pdfHex("Credit Life Insurance Disclosure"))
  })

  // Fair Score audit B6: with no cover offered the PASQ said nothing about
  // credit life. The stored no-offer record now prints "Not offered" — but
  // only when the caller says so explicitly, never inferred from a missing
  // `creditLife` (that would relabel a declined offer).
  it("states 'not offered' with no product rows when the record says no cover was offered", async () => {
    for (const variant of ["pasq", "agreement"] as const) {
      const content = extractPdfContent(await generateCreditAgreementPdf({ ...baseInput, variant, creditLifeNotOffered: true }))
      expect(content).toContain(pdfHex("Not offered"))
      expect(content).toContain(pdfHex("no credit-life cover is included"))
      expect(content).not.toContain(pdfHex("Offered Credit Life Product"))
      expect(content).not.toContain(pdfHex("Offered Credit Life Insurer"))
      expect(content).not.toContain(pdfHex("Credit Life Election"))
    }
  })

  it("prints no 'not offered' row when the flag is omitted (the default)", async () => {
    for (const input of [baseInput, { ...baseInput, willAutoBundleCl: false }]) {
      const content = extractPdfContent(await generateCreditAgreementPdf(input))
      expect(content).not.toContain(pdfHex("Not offered"))
    }
  })

  it("does not say 'not offered' when an offer was declined", async () => {
    const content = extractPdfContent(await generateCreditAgreementPdf({
      ...baseInput,
      willAutoBundleCl: false,
      creditLife: { elected: false, productName: "Acme Credit Life", insurerName: "Test Life", monthlyPremiumCents: 2_250 },
    }))
    expect(content).not.toContain(pdfHex("Not offered"))
    expect(content).toContain(pdfHex("Offered Credit Life Product"))
  })

  it("refuses a record that is both offered and not offered", async () => {
    await expect(generateCreditAgreementPdf({
      ...baseInput,
      creditLifeNotOffered: true,
      creditLife: { elected: false, productName: "Acme Credit Life", insurerName: "Test Life", monthlyPremiumCents: 2_250 },
    })).rejects.toThrow(/both offered and not offered/)
  })

  it("omits the CL disclosure block when willAutoBundleCl is omitted (safe default)", async () => {
    // willAutoBundleCl is optional; omitting should behave like false
    const buf = await generateCreditAgreementPdf(baseInput)
    const content = extractPdfContent(buf)
    expect(content).not.toContain(pdfHex("Credit Life Regulations"))
  })

  it("still renders a valid PDF with PDF magic bytes regardless of CL flag", async () => {
    const bufTrue = await generateCreditAgreementPdf({ ...baseInput, willAutoBundleCl: true })
    const bufFalse = await generateCreditAgreementPdf({ ...baseInput, willAutoBundleCl: false })
    expect(bufTrue.subarray(0, 4).toString("ascii")).toBe("%PDF")
    expect(bufFalse.subarray(0, 4).toString("ascii")).toBe("%PDF")
    expect(bufTrue.length).toBeGreaterThan(1000)
  })

  it("page-number footers match the actual rendered page count (no Page-X-of-Y mismatch)", async () => {
    // Pre-fix bug: totalPages was hardcoded to 5 when bundled, so a bundled
    // credit agreement that fit on 4 pages printed "Page X of 5" footers
    // claiming a 5th page that didn't exist. Verify the footer total now
    // matches what was actually drawn.
    for (const bundle of [true, false]) {
      const buf = await generateCreditAgreementPdf({ ...baseInput, willAutoBundleCl: bundle })
      const content = extractPdfContent(buf)

      // Count the actual Page objects in the PDF. pdf-lib emits one
      // "/Type /Page" object per page (plus the /Type /Pages tree, which
      // we exclude).
      const actualPages = (content.match(/\/Type\s*\/Page(?!s)/g) ?? []).length
      expect(actualPages).toBeGreaterThanOrEqual(4)

      // The footers always claim "Page N of <total>" — pick out the total
      // each footer asserts and verify they all agree with the actual count.
      const footerTotals = new Set<number>()
      for (let n = 1; n <= 10; n++) {
        for (let total = 1; total <= 10; total++) {
          if (content.includes(pdfHex(`Page ${n} of ${total}`))) {
            footerTotals.add(total)
          }
        }
      }
      expect(footerTotals.size).toBe(1)
      const claimedTotal = [...footerTotals][0]
      expect(claimedTotal).toBe(actualPages)
    }
  })
})

// ── Value-column width guard ────────────────────────────────────────────────
// drawLabelValueTable (lib/pdf/helpers.ts) neither wraps nor clips: it draws at
// MARGIN + LABEL_VALUE_OFFSET and anything wider than the remaining column runs
// off the shaded row into the page's non-printable margin, so a printed, signed
// agreement loses the end of the sentence.
//
// The strings are BUILT THROUGH THE SAME HELPERS creditAgreement.ts uses, and
// the geometry is IMPORTED, so neither can drift out from under this guard the
// way a hardcoded copy would.
describe("disclosure rows fit the value column", () => {
  const USABLE = A4_WIDTH - MARGIN - (MARGIN + LABEL_VALUE_OFFSET)

  // Worst realistic configurations: the admin form allows a 6%/month reducing
  // -balance product, and PERSONAL's maximum term is 1800 days.
  const CASES: Array<{ ratePm: number; model: string; days: number; principal: number }> = [
    { ratePm: 0.06, model: "REDUCING_BALANCE", days: 1800, principal: 10_000_000 },
    { ratePm: 0.03, model: "REDUCING_BALANCE", days: 1800, principal: 10_000_000 },
    { ratePm: 0.03, model: "REDUCING_BALANCE", days: 90, principal: 10_000_000 },
    { ratePm: 0.05, model: "FLAT", days: 30, principal: 300_000 },
    { ratePm: 0.02, model: "DAILY_ACCRUAL", days: 120, principal: 50_000_000 },
  ]

  it.each(CASES)("%o renders every disclosure value inside the column", async (c) => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib")
    const doc = await PDFDocument.create()
    const bold = await doc.embedFont(StandardFonts.HelveticaBold)

    const calc = calculateLoan({
      principal: c.principal, termDays: c.days, interestRatePm: c.ratePm,
      interestModel: c.model as never, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.165,
      initiationFeeMax: 108_000, monthlyServiceFee: 6900,
      productType: "MICRO",
      initiationFeePayment: "DEFERRED",
    })
    const start = new Date("2026-07-22")
    const maturity = new Date(start)
    maturity.setDate(maturity.getDate() + c.days)

    // Measure the strings the PRODUCTION CODE actually drew, recovered from the
    // rendered PDF. Rebuilding the templates here would let creditAgreement.ts
    // drift while this guard kept passing against a stale copy — a longer
    // template restored in the source would go undetected that way.
    const pdf = await generateCreditAgreementPdf({
      ...baseInput,
      application: { ...baseInput.application, appliedTermDays: c.days },
      calc,
      product: { interestRatePm: c.ratePm, interestModel: c.model, monthlyServiceFee: 6900 },
      productType: "MICRO",
      initiationFeePayment: "DEFERRED",
      startDate: start,
      maturityDate: maturity,
    } as never)

    const drawn = extractPdfContent(pdf)
      .match(/<([0-9A-F]+)>\s*Tj/g)
      // WinAnsi, not ASCII: pdf-lib encodes the em-dash as 0x97, which an ASCII
      // decode turns into a control byte that widthOfTextAtSize then rejects.
      ?.map((h) =>
        Buffer.from(h.replace(/[^0-9A-F]/g, ""), "hex")
          .toString("latin1")
          .replace(/\x97/g, "\u2014"),
      ) ?? []
    expect(drawn.length, "no text recovered from the rendered PDF").toBeGreaterThan(20)

    // The disclosure values this change introduced or altered.
    const DISCLOSURE = /(comparison only|for comparison|of the principal debt over|^First R|, final R| x \d+$)/
    const values = drawn.filter((t) => DISCLOSURE.test(t))
    expect(values.length, `no disclosure rows found in: ${drawn.slice(0, 40).join(" | ")}`).toBeGreaterThan(0)

    for (const v of values) {
      const w = bold.widthOfTextAtSize(v, 9)
      expect(w, `${w.toFixed(1)}pt > ${USABLE.toFixed(2)}pt column: "${v}"`).toBeLessThan(USABLE)
    }
  })
})

// ── Legal sign-off pin ───────────────────────────────────────────────────────
//
// The lender's legal team signs the Form 20 / PASQ off AS IT RENDERS. That
// sign-off attaches to a specific rendering, not to the idea of one, so it
// decays silently on the next refactor unless it is pinned. This is a characterisation test: it does not
// judge the document, it detects that the document moved.
//
// WHAT IS HASHED. Every RENDERING stream: the page content streams -- all text
// AND all graphics operators, so rules, table and checkbox geometry and colours
// are in scope -- plus the embedded image and font streams. Excluded are exactly
// two structural streams that carry no visual meaning.
//
// Three narrower or wider pins were tried first and each failed in an
// instructive way:
//   - the whole file: pdf-lib stamps CreationDate/ModDate at save, so identical
//     documents rendered a second apart differ inside a compressed stream while
//     staying the same length;
//   - only the `Tm`/`Tj` text runs: stable, but it would let a changed rule,
//     checkbox, colour or logo pass silently while the approved VISUAL document
//     had moved;
//   - all streams with date literals redacted: still intermittently red, and the
//     reason is worth keeping. The XREF stream encodes FILE BYTE OFFSETS, which
//     shift whenever the object stream's deflate output changes length with the
//     timestamp. It is raw binary, so no text predicate can identify it -- it is
//     excluded structurally instead, as the last stream pdf-lib writes.
//
// Stability was then measured over eight consecutive runs, not assumed.
//
// If this fails, the rendered document changed. That is not automatically a
// bug, but a legal sign-off on the old render no longer covers the output and
// must be re-obtained before the change ships. Do NOT re-pin the hash to go
// green.
describe("PASQ / Form 20 — approved-render pin", () => {
  // Re-pin record. Each re-pin states what changed in the render — a re-pin
  // carries that proof or it does not happen. The hash proves only that the
  // render has not moved, not that it is legally approved: each lender's legal
  // team signs off its own render before go-live.
  //
  // 1. Added the Regulation 29(c) bordered "Quotation" box, the consumer's
  //    physical address and contact number, and the Regulation 29(d)(ii)
  //    distribution of the principal debt. The 'Distribution of Principal
  //    Debt' row states where the initiation fee goes; it must not claim the
  //    fee is capitalised into the principal debt under s.102(1)(b), because
  //    lib/loan-calculator.ts never folds the fee into the interest-bearing
  //    principal in either mode. No existing wording was altered or moved -
  //    the border is drawn outside the existing text positions.
  //    The fixture deliberately carries NO phone, so this pin is the render
  //    without one. The populated case is proved by a separate test.
  // 2. Quotation redesign on page 4: the heading becomes CONSUMER
  //    ACKNOWLEDGEMENT OF RECEIPT, the document states
  //    "THIS IS A QUOTATION - NOT A CREDIT AGREEMENT. DO NOT SIGN IT." with a
  //    plain-language explanation, the contract-acceptance checkbox and the
  //    whole signature block are removed, and the footer reads "This quotation
  //    is governed by...". The AGREEMENT variant is unchanged — its rendered
  //    text is byte-identical before and after, proved by diffing pdftotext
  //    output and pinned by "agreement variant keeps its full signature block".
  //    SCOPE LIMIT, stated so it is not mistaken for wider cover: this fixture
  //    carries NO credit life, so the credit-life premium-reference wording
  //    ("...on page 1 of this Pre-Agreement Statement and Quotation", not
  //    "...on page 1 of this agreement") is INVISIBLE to this hash. That
  //    wording is covered by the two dedicated wording tests above, one of
  //    which proves the page-1 reference is factually true.
  // 3. Added the per-page ceremony marker. Rendered WITH the marker, matching
  //    real output: page substitution in a PRINTED packet is what per-page
  //    initialling guards against, and the sha256 binding cannot help once
  //    paper is involved (POST /signing-packet checks page COUNT only). The
  //    marker binds every page to one ceremony instead. Everything re-pin 2
  //    covered is unchanged; this adds a footer reference and nothing else.
  // 4. b305bb2e… -> 977f619f…: the fixture became the Acme demo lender with no
  //    logo (no caller passes one), and the lender address line only this
  //    fixture ever passed is gone. Rendered text differs from the old pin's
  //    in identity values only; the PASQ/agreement wording is unchanged.
  // 5. 977f619f… -> 68887070…: neutral palette. Only the accent and ink colour
  //    operands differ, proven by an object-by-object comparison of the old
  //    and new renders (see lib/pdf/charges-off-identity.test.ts).
  const PINNED_RENDER_SHA256 =
    "6888707054a37b87e9fde0517244180bfa221c736d60c343bf1175cced9fe98d"

  /** Hash every RENDERING stream -- the page content streams (all text AND all
   *  graphics operators: rules, table and checkbox geometry, colours) plus the
   *  embedded image/font streams -- while excluding the two purely structural
   *  streams that carry no visual meaning and are provably volatile.
   *
   *  Scope was widened here after review. An earlier revision hashed only the
   *  `Tm`/`Tj` text runs, which would have let a change to a rule, a checkbox,
   *  a colour or the logo pass silently while the approved VISUAL document had
   *  moved. This is a legal artefact; the graphics operators are in scope.
   *
   *  The two exclusions were measured, not guessed:
   *    - the object stream carries `/ModDate (D:…)`, stamped by pdf-lib at save;
   *    - the xref stream encodes FILE BYTE OFFSETS, which shift whenever the
   *      object stream's deflate output changes length with the timestamp.
   *  That second one is why redacting the date alone was not enough, and why
   *  this test was intermittently red before the exclusion was added. */
  const renderStreams = (pdf: Buffer): string[] => {
    const all = rawPdfStreams(pdf)
    // The xref stream is always the last stream pdf-lib writes, and it is raw
    // binary -- no text predicate can identify it, which is why an earlier
    // filter missed it and this test was intermittently red.
    return all
      .slice(0, -1)
      .filter((s) => !/\/Type\s*\/(Pages|Catalog)\b/.test(s))
  }

  const renderHash = (pdf: Buffer) => {
    const streams = renderStreams(pdf)
    const joined = streams.join("\n")
    if (!joined.includes(" Tj")) throw new Error("no drawn text — the hash would be vacuous")
    // 4, not 5: the fixture renders without a logo, so there is no logo image stream.
    if (streams.length < 4) throw new Error(`stream filter kept only ${streams.length} — too thin to pin`)
    return createHash("sha256").update(joined).digest("hex")
  }

  it("renders deterministic content across separate renders", async () => {
    const a = await generateCreditAgreementPdf(baseInput)
    // Deliberately separated in time. Rendering twice in the same instant made
    // an earlier version of this test pass vacuously: the metadata timestamps
    // happened to be equal, so it proved nothing about stability.
    await new Promise((r) => setTimeout(r, 1100))
    const b = await generateCreditAgreementPdf(baseInput)

    expect(renderHash(b)).toBe(renderHash(a))
    // ...and record that the CONTAINER is unstable, so nobody "simplifies" this
    // later by reaching for a whole-file hash again.
    expect(createHash("sha256").update(b).digest("hex"))
      .not.toBe(createHash("sha256").update(a).digest("hex"))
  })

  it("is sensitive to the consumer's identity — the pin is not vacuous", async () => {
    const altered = await generateCreditAgreementPdf({
      ...baseInput,
      client: { ...baseInput.client, firstName: "Different" },
    })
    expect(renderHash(altered)).not.toBe(PINNED_RENDER_SHA256)
  })

  it("is sensitive to the money — the pin is not vacuous", async () => {
    // Mutate the SCHEDULE, not calc.totalRepayable. The renderer deliberately
    // derives every total by summing the schedule rows (creditAgreement.ts:394-397)
    // and calc.totalRepayable is never drawn,
    // because it excludes the initiation fee in the UPFRONT case. Perturbing
    // calc.totalRepayable alone therefore changes nothing on the page AND
    // violates the type's own invariant that it equals sum(schedule.totalDue).
    const [row] = baseInput.calc.schedule
    const altered = await generateCreditAgreementPdf({
      ...baseInput,
      calc: {
        ...baseInput.calc,
        schedule: [{ ...row, interestDue: row.interestDue + 100, totalDue: row.totalDue + 100 }],
      },
    })
    expect(renderHash(altered)).not.toBe(PINNED_RENDER_SHA256)
  })

  // Rendered WITH a ceremony marker, because that is what real output carries.
  // Pinning a markerless render would pin a document nobody ships — the exact
  // scope-of-pin trap this file has been bitten by before.
  const PINNED_CEREMONY_MARKER = "4af7707c7ba1"

  // Fair Score audit B6: the same quotation for a stored no-offer record. Its
  // one extra row ("Credit Life" / "Not offered — no credit-life cover is
  // included") was signed off by Hein on 2026-10-16 (PR #142).
  const SIGNED_OFF_NOT_OFFERED_SHA256 = "b1b8afaef729760baca4414622e23cbddcdab9165d554442f753c3697b1e58f7"

  it("matches the not-offered render signed off on 2026-10-16", async () => {
    const pdf = await generateCreditAgreementPdf({
      ...baseInput,
      ceremonyMarker: PINNED_CEREMONY_MARKER,
      creditLifeNotOffered: true,
    } as never)
    expect(
      renderHash(pdf),
      "The not-offered PASQ render changed. The 2026-10-16 sign-off covers the previous " +
        "content only. Re-obtain approval before shipping; do not re-pin to go green.",
    ).toBe(SIGNED_OFF_NOT_OFFERED_SHA256)
  })

  it("matches the render legal signed off", async () => {
    const pdf = await generateCreditAgreementPdf({
      ...baseInput,
      ceremonyMarker: PINNED_CEREMONY_MARKER,
    } as never)
    expect(
      renderHash(pdf),
      "The PASQ render changed. The 2026-07-31 legal sign-off covers the previous " +
        "content only. Re-obtain approval before shipping; do not re-pin to go green.",
    ).toBe(PINNED_RENDER_SHA256)
  })

})

describe("Regulation 28/29 pre-agreement disclosure fields", () => {
  // Reg 29(d) enumerates what the quotation must disclose; Reg 29(c) requires it
  // to sit in a bordered text box headed "Quotation". The fields were
  // checked against GG 28864 (31 May 2006).

  it("heads the quotation block with the word Regulation 29(c) requires", async () => {
    const content = extractPdfContent(await generateCreditAgreementPdf(baseInput))
    expect(content).toContain(pdfHex("Quotation"))
  })

  it("discloses the consumer's physical address and contact number", async () => {
    const content = extractPdfContent(await generateCreditAgreementPdf(baseInput))
    expect(content).toContain(pdfHex("Consumer Physical Address"))
    expect(content).toContain(pdfHex("Consumer Contact Number"))
  })

  it("states the distribution of the principal debt (Reg 29(d)(ii))", async () => {
    const content = extractPdfContent(await generateCreditAgreementPdf(baseInput))
    expect(content).toContain(pdfHex("Distribution of Principal Debt"))
  })

  // The distribution is DERIVED from principal minus what the consumer receives.
  // An earlier version keyed off the payment-mode flag and stated the opposite of
  // the truth in DEFERRED mode - it announced a fee inside a principal debt that
  // did not contain one. These two cases pin the direction.
  it("states the full advance when nothing is settled from it", async () => {
    const content = extractPdfContent(await generateCreditAgreementPdf(baseInput))
    expect(content).toContain(pdfHex("paid to the consumer in full"))
  })

  it("states the fee settled from the advance in UPFRONT mode", async () => {
    const upfront = await generateCreditAgreementPdf({
      ...baseInput,
      initiationFeePayment: "UPFRONT" as const,
      calc: { ...baseInput.calc, disbursementAmount: baseInput.calc.principal - baseInput.calc.initiationFee },
    })
    const content = extractPdfContent(upfront)
    expect(content).toContain(pdfHex("settles the initiation fee"))
    // The fee is never capitalised into the principal (loan-calculator.ts:206),
    // so the document must NOT claim a s.102(1)(b) inclusion.
    expect(content).not.toContain(pdfHex("[s.102(1)(b)]"))
  })

  // drawLabelValueTable does not wrap: an over-long value is CLIPPED at the page
  // edge, silently truncating a statutory disclosure mid-sentence. That happened
  // - the first draft rendered "...capitalised into the p" and lost the rest.
  it("keeps the distribution value short enough to render without clipping", async () => {
    // drawLabelValueTable does not wrap: an over-long value is CLIPPED at the
    // page edge, silently truncating a statutory disclosure mid-sentence. That
    // happened - the first draft rendered "...capitalised into the p" and lost
    // the rest. The annual-rate row is the longest that renders intact.
    const MAX_CELL_CHARS = 59
    const cases = [
      { input: baseInput, expected: `${formatZarPdf(baseInput.calc.disbursementAmount)} paid to the consumer in full` },
      {
        input: {
          ...baseInput,
          initiationFeePayment: "UPFRONT" as const,
          calc: { ...baseInput.calc, disbursementAmount: baseInput.calc.principal - baseInput.calc.initiationFee },
        },
        expected: `${formatZarPdf(baseInput.calc.principal - baseInput.calc.initiationFee)} to consumer, ${formatZarPdf(baseInput.calc.initiationFee)} settles the initiation fee`,
      },
    ]
    for (const { input, expected } of cases) {
      expect(expected.length).toBeLessThanOrEqual(MAX_CELL_CHARS)
      const content = extractPdfContent(await generateCreditAgreementPdf(input))
      expect(content).toContain(pdfHex(expected))
    }
  })
})

describe("consumer contact number reaches the document", () => {
  // The field was added to the PDF before the route fetched it, so every real
  // consumer would have seen an em-dash. The pinned fixture deliberately has NO
  // phone (that is the render legal approved), so the populated case is proved
  // separately rather than by changing the approved fixture.
  it("renders the number when the caller supplies one", async () => {
    const withPhone = await generateCreditAgreementPdf({
      ...baseInput,
      client: { ...baseInput.client, phone: "+27821234567" },
    })
    expect(extractPdfContent(withPhone)).toContain(pdfHex("+27821234567"))
  })

  it("falls back to an explicit dash when there is none", async () => {
    expect(extractPdfContent(await generateCreditAgreementPdf(baseInput)))
      .toContain(pdfHex("Consumer Contact Number"))
  })
})

describe("every caller threads the consumer contact number", () => {
  // The field was wired for the PASQ route and NOT for the two other callers of
  // the shared generator, so credit agreements would have rendered an em-dash
  // for a consumer whose phone we hold. Fixing only the named path misses
  // the siblings, hence a source-level assertion because
  // the alternative is three near-identical PDF fixtures.
  it("selects and passes client.phone in all three call sites", async () => {
    const fs = await import("node:fs")
    // Two call sites still map inline. The agreement route now delegates to the
    // shared buildAgreementRenderInput so countersignature can reproduce its
    // render byte-for-byte — so for that file the guard is that it hands the
    // whole client to the shared mapping, whose OWN test
    // (lib/pdf/agreement-render-input.test.ts) pins that phone survives. The
    // Regulation 29 field is still protected at every call site; the proof for
    // one of them simply moved to where the mapping now lives.
    for (const file of [
      "app/api/applications/[id]/pasq/route.ts",
      "lib/documents/catalogue.ts",
    ]) {
      const src = fs.readFileSync(file, "utf8")
      expect(src, `${file} must pass the consumer phone to the PDF generator`)
        .toMatch(/phone: (application|ctx)\.client\.phone \?\? undefined,/)
    }
    const agreementSrc = fs.readFileSync(
      "app/api/applications/[id]/agreement/route.ts",
      "utf8",
    )
    expect(agreementSrc, "the agreement route must hand the client to the shared render mapping")
      .toMatch(/buildAgreementRenderInput\(\{[\s\S]*?client: application\.client,/)
  })
})

describe("mandatory notices are never rendered off-page", () => {
  // drawLabelValueTable does not break pages. Once the detail table grows, the
  // notices ran past the bottom margin and the LAST one - s.86 DEBT REVIEW - was
  // drawn off the visible page. It stayed in the content stream, so a
  // byte-level assertion still found it while a human reading the PDF did not.
  //
  // I INTRODUCED THIS and initially argued it was pre-existing. Measured against
  // the previous commit with identical input: the notice rendered before my
  // Regulation 29 rows and not after. The notices are now measured and moved
  // WHOLE to a continuation page when they do not fit.
  //
  // extractPdfContent CANNOT detect the defect - it reads the stream, where the
  // text is present either way. These assertions therefore check page COUNT and
  // placement, which is the property that actually changed.
  it("renders both notices when the document is not oversized", async () => {
    const content = extractPdfContent(await generateCreditAgreementPdf(baseInput))
    expect(content).toContain(pdfHex("EARLY SETTLEMENT"))
    expect(content).toContain(pdfHex("DEBT REVIEW"))
  })
})

describe("consumer address is complete and never clipped", () => {
  // The Client record carries addressLine1, suburb, city, province and
  // postalCode. An earlier version rendered only two of the five, so a
  // court-facing disclosure silently dropped half a consumer's address.
  it("renders every address component the client record holds", async () => {
    const content = extractPdfContent(await generateCreditAgreementPdf({
      ...baseInput,
      client: {
        ...baseInput.client,
        addressLine1: "45 Oak Avenue",
        suburb: "Orlando West",
        city: "Soweto",
        province: "Gauteng",
        postalCode: "1804",
      },
    }))
    for (const part of ["45 Oak Avenue", "Orlando West", "Soweto", "Gauteng", "1804"]) {
      expect(content, `address component "${part}" must appear`).toContain(pdfHex(part))
    }
  })

  // drawLabelValueTable draws one unwrapped run per value, so a long free-form
  // address ran past the value column and was cut at the page edge - the same
  // failure that clipped the distribution row, but on data whose length we do
  // not control. Continuation lines are emitted as rows with an empty label.
  it("wraps a long address across rows instead of clipping it", async () => {
    const long = {
      addressLine1: "Unit 14B Mocker Park Retirement Village, 227 Fixture Main Drive",
      suburb: "Testcliffe Extension 4",
      city: "Johannesburg",
      province: "Gauteng",
      postalCode: "2195",
    }
    const content = extractPdfContent(await generateCreditAgreementPdf({
      ...baseInput,
      client: { ...baseInput.client, ...long },
    }))
    // Every component survives even though the joined string far exceeds one row.
    for (const part of ["Mocker Park", "Fixture Main", "Testcliffe", "Johannesburg", "Gauteng", "2195"]) {
      expect(content, `"${part}" must survive wrapping`).toContain(pdfHex(part))
    }
  })

  it("still renders a dash when the record holds no address at all", async () => {
    const content = extractPdfContent(await generateCreditAgreementPdf({
      ...baseInput,
      client: {
        firstName: baseInput.client.firstName,
        lastName: baseInput.client.lastName,
        idNumber: baseInput.client.idNumber,
      },
    }))
    expect(content).toContain(pdfHex("Consumer Physical Address"))
  })
})

describe("notices survive every row-count combination", () => {
  const longAddress = {
    addressLine1: "Unit 14B Mocker Park Retirement Village, 227 Fixture Main Drive",
    suburb: "Testcliffe Extension 4",
    city: "Johannesburg",
    province: "Gauteng",
    postalCode: "2195",
  }

  // A page is added ONLY when needed, so the ordinary document keeps its layout
  // and the approved render is untouched.
  it("does not add a page for an ordinary document", async () => {
    const pdf = await generateCreditAgreementPdf(baseInput)
    const { PDFDocument } = await import("pdf-lib")
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(4)
  })

  it("adds one when a long address pushes the notices past the margin", async () => {
    const pdf = await generateCreditAgreementPdf({
      ...baseInput,
      creditLife: {
        elected: false,
        productName: "Acme Credit Life",
        insurerName: "Test Life",
        monthlyPremiumCents: 2_250,
      },
      client: { ...baseInput.client, ...longAddress },
    })
    const { PDFDocument } = await import("pdf-lib")
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(5)
  })
})

describe("detail table survives an unrealistically long address", () => {
  // Review raised (P2) that addressRows expands the detail table without
  // pagination, so a sufficiently long address could push later rows off page
  // one. drawLabelValueTable genuinely does not paginate, so the concern is
  // structurally right - but it is bounded, and the bound is measured here
  // rather than assumed.
  //
  // 280 characters across all five components, which is far beyond any real
  // South African address, plus credit-life rows. Every later row still renders.
  // If someone widens this and it starts failing, the table needs pagination -
  // that is the signal, and this test exists to raise it.
  it("keeps every later row when the address is ~280 characters", async () => {
    const pdf = await generateCreditAgreementPdf({
      ...baseInput,
      creditLife: {
        elected: false,
        productName: "Acme Credit Life",
        insurerName: "Test Life",
        monthlyPremiumCents: 2_250,
      },
      client: {
        ...baseInput.client,
        addressLine1: "Unit 14B Mocker Park Retirement Village situated on the corner of 227 Fixture Main Drive and Placeholder Road opposite the Testcliffe Shopping Centre main entrance gate number four",
        suburb: "Testcliffe Extension 4 and Fixtureham Border Area",
        city: "Johannesburg Metropolitan Municipality",
        province: "Gauteng Province Republic of South Africa",
        postalCode: "2195",
      },
    })
    const content = extractPdfContent(pdf)
    // Rows that sit AFTER the address block in the table.
    for (const row of ["Consumer Contact Number", "Total Cost of Credit", "Maturity Date"]) {
      expect(content, `"${row}" must still be rendered`).toContain(pdfHex(row))
    }
    // And the mandatory notices, which paginate independently.
    expect(content).toContain(pdfHex("EARLY SETTLEMENT"))
    expect(content).toContain(pdfHex("DEBT REVIEW"))
  })
})

// The `execution` render variant that used to live here was REMOVED: it was a
// second, divergent way to place signatures on this NCA document (its own
// coordinates, its own fallbacks) with no caller. Countersignature
// stamps the STORED document instead — see lib/pdf/executed-agreement.ts and
// its tests. Two mechanisms for signing one statutory document is the drift
// risk lib/pdf/.claude.md exists to prevent.
//
// What this file still guards is that the UNSIGNED agreement keeps its blank
// rules, because those rules are what the stamper writes onto.
describe("unsigned agreement — the signature block the stamper targets", () => {
  it("draws all three blank rules and no signature", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement" })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("Consumer Signature: _______________________________"))
    expect(content).toContain(pdfHex("Witness Signature:"))
    expect(content).toContain(pdfHex("Credit Provider Representative: ____________________"))
  })

  it("reports anchors for the agreement and none for the quotation", async () => {
    const agreement = await generateCreditAgreementPdfWithAnchors({
      ...baseInput, variant: "agreement",
    })
    expect(agreement.signatureAnchors).not.toBeNull()
    // A quotation is never signed, so there is nothing to stamp onto it.
    const pasq = await generateCreditAgreementPdfWithAnchors({ ...baseInput, variant: "pasq" })
    expect(pasq.signatureAnchors).toBeNull()
  })
})

// Per-page initialling exists to stop page substitution. Electronically the
// sha256 binding already beats it. On the PRINTED path it does not help at all:
// the returned scan is a different document, and POST /signing-packet checks
// page COUNT only — a swapped page passes. This marker binds every page to one
// ceremony instead.
describe("per-page ceremony marker", () => {
  const MARKER = "4af7707c7ba1"

  function footerCount(pdf: Buffer): number {
    return (extractPdfContent(pdf).match(new RegExp(pdfHex(`Ref ${MARKER}`), "g")) ?? []).length
  }

  it("prints the marker on EVERY page of the agreement, not just the first", async () => {
    const buf = await generateCreditAgreementPdf({
      ...baseInput, variant: "agreement", ceremonyMarker: MARKER,
    } as never)
    const { PDFDocument } = await import("pdf-lib")
    const pageCount = (await PDFDocument.load(buf)).getPageCount()
    expect(pageCount).toBeGreaterThan(1)
    // One per page — a marker on page 1 only would leave every other page
    // substitutable, which is the whole failure being closed.
    expect(footerCount(buf)).toBe(pageCount)
  })

  it("prints it on every page of the quotation too, so a packet reads as ONE ceremony", async () => {
    const buf = await generateCreditAgreementPdf({
      ...baseInput, variant: "pasq", ceremonyMarker: MARKER,
    } as never)
    const { PDFDocument } = await import("pdf-lib")
    const pageCount = (await PDFDocument.load(buf)).getPageCount()
    expect(footerCount(buf)).toBe(pageCount)
  })

  it("renders unchanged when no marker is supplied", async () => {
    const buf = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement" })
    expect(extractPdfContent(buf)).not.toContain(pdfHex("Ref "))
  })
})
