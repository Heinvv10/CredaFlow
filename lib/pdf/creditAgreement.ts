import { PDFDocument, StandardFonts, type PDFPage } from "pdf-lib"
import type { LoanCalcResult } from "@/lib/loan-calculator"
import {
  A4_WIDTH, A4_HEIGHT, MARGIN, CONTENT_WIDTH, LABEL_VALUE_OFFSET,
  DARK, ACCENT, GRAY, WHITE,
  formatZarPdf, formatDatePdf,
  drawText, drawTableRow, drawLabelValueTable,
  drawPageNumber, drawSectionTitle, drawRowsWithContinuation,
  embedLogo, fitLogo,
} from "./helpers"
import { annualisedInterestRate, termInterestPercent } from "@/lib/loan/annualised-rate"
import { describeInstalments, formatInstalmentPattern } from "@/lib/loan/instalment-pattern"
import type { PasqBillingEvidence } from "@/lib/compliance/pasq"
import { requireLenderIdentityFields, type LenderIdentity } from "@/lib/config/identity-schema"

interface AgreementOpts {
  /**
   * Which statutory document this render IS. One template produces both
   * because they share the cost-of-credit table, schedule and terms — but
   * they are DIFFERENT documents under the Act:
   * - "pasq": the s.92 Pre-Agreement Statement & Quotation (Form 20), issued
   *   and acknowledged during the signing ceremony. Rendering is byte-stable
   *   with the pre-variant template so acknowledged document digests hold.
   * - "agreement": the credit agreement itself (s.93) — titled as such,
   *   referencing (not re-issuing) the acknowledged quotation.
   * Required so the compiler enumerates every call site.
   */
  variant: "pasq" | "agreement"
  lender: Pick<LenderIdentity, "legalName" | "ncrNumber">
  /** Letterhead logo, PNG bytes. Absent → text header. */
  logo?: Uint8Array
  client: {
    firstName: string; lastName: string; idNumber: string
    addressLine1?: string; suburb?: string; city?: string; province?: string; postalCode?: string
    phone?: string
  }
  application: { reference: string; agreementType?: string; appliedTermDays: number }
  calc: LoanCalcResult
  product: { interestRatePm: number; interestModel: string; monthlyServiceFee: number }
  startDate: Date
  maturityDate: Date
  /** Instant the Form 20 quotation was presented to the consumer. */
  quotePresentedAt: Date
  /** Last SAST calendar date on which the quotation remains binding under
   * NCA s.92(3). The prescribed Form 20 notice says "5 DAYS"; this exact date
   * makes the Act's five-business-day period unambiguous to the consumer. */
  quoteValidUntilDate: string
  /** Legacy compatibility switch for rendering the Credit Life Regulations
   * disclosure. New agreement generation must pass the exact `creditLife`
   * evidence and derive this boolean from the explicit election plus current
   * product availability. */
  willAutoBundleCl?: boolean
  /** Exact election evidence captured before PASQ generation. The legacy
   * boolean remains for rollback/test compatibility but new callers must bind
   * the displayed product, insurer, and premium. */
  creditLife?: {
    elected: boolean
    productName: string
    insurerName: string
    monthlyPremiumCents: number
    premiumPeriods?: number
    totalPremiumCents?: number
    /** Exact premium-inclusive schedule accepted in the versioned PASQ. */
    billing?: PasqBillingEvidence
  }
  /** The consumer's NCA s.101 initiation-fee payment option. Drives the
   *  "Amount Advanced" / "Initiation Fee Payment" disclosure rows. */
  initiationFeePayment?: "DEFERRED" | "UPFRONT"
  ceremonyMarker?: string
}

// LEGAL_WORDING_BEGIN — G2 Credit Life Insurance Regulations, 2017 disclosure.
// Legally reviewed text: do NOT paraphrase it. A change needs the lender's
// legal sign-off before merge. Each entry is wrapped by wrapText()
// at render time (entries here are full paragraphs, NOT pre-wrapped lines).
const CL_DISCLOSURE_LINES = [
  // Heading + governing-regulation citation
  "Credit Life Insurance Disclosure.",
  "Where this credit agreement bundles a credit life insurance policy, the following disclosure is made under the Credit Life Insurance Regulations, 2017 (Government Notice No. 103, Government Gazette No. 40606, 9 February 2017), made under the National Credit Act 34 of 2005.",
  "",
  // Reg 3(2) — minimum benefits
  "Minimum benefits (Regulation 3(2)).",
  "The bundled credit life policy provides for at least the settlement of (a) the outstanding balance of your obligations under this credit agreement on your death or permanent disability; and (b) the obligations that become due and payable for up to 12 months, the remaining repayment period, or until you are no longer disabled, unemployed or unable to earn an income (whichever period is shortest) on temporary disability, unemployment or inability to earn an income other than as a result of permanent disability.",
  "",
  // Reg 3(1) — maximum prescribed cost
  "Maximum prescribed cost (Regulation 3(1)).",
  "The cost of the bundled credit life cover does not exceed the maximum prescribed under Regulation 3(1). For an unsecured or short-term credit transaction the maximum is R4.50 per R1 000 of the deferred amount per month.",
  "",
  // Reg 4 — exclusions (and the Reg 4(2) disclosure obligation)
  "Exclusions and waiting periods (Regulation 4).",
  "The policy may exclude or limit cover only in the circumstances permitted by Regulation 4. The applicable exclusions, limitations and any waiting periods are set out in the policy schedule. In compliance with Regulation 4(2), they will be explained to you on the date this credit agreement is entered into and communicated to you at regular intervals thereafter.",
  "",
  // Reg 7 + s106(4)(a) NCA — substitution
  "Right of substitution (Regulation 7; section 106(4)(a) of the National Credit Act).",
  "You may, at any time after this credit agreement is entered into, substitute the bundled credit life policy with a credit life policy of your own choosing, provided that the alternative policy provides at least the minimum benefits required by Regulation 3. You must provide us with the details of the new insurer within five business days of taking up the new policy.",
  "",
  // s92 NCA — premium disclosure in PASQ
  "Premium disclosure (section 92 of the National Credit Act).",
  // Factual-reference correction only, riding the same legal gate as the rest
  // of the quotation. Wording such as "...in the Pre-Agreement Statement and
  // Quotation on page 1 of this agreement" would, on the PASQ variant, call the
  // quotation an agreement — the confusion that leads consumers to sign it as
  // one. Verified: with real election evidence the premium rows
  // ("Offered Credit Life Premium", "Credit Life Premiums Charged", "Premium
  // Collection") do render on PAGE 1 of the PASQ, so the page reference is
  // true. The substantive Regulation 3/4/7 wording above is untouched.
  "The premium for the bundled credit life cover forms part of the cost of credit and is disclosed on page 1 of this Pre-Agreement Statement and Quotation.",
] as const
// LEGAL_WORDING_END

/** Where one blank signature rule sits on the rendered page, in PDF points. */
export interface AgreementRuleAnchor {
  /** Left edge of the signature rule — where the artefact is stamped. */
  signatureX: number
  signatureWidth: number
  /** Left edge of the date rule. */
  dateX: number
  dateWidth: number
  /** Baseline of the rule's text run. The artefact sits ABOVE this. */
  baselineY: number
}

/**
 * The coordinates of the unsigned agreement's signature block.
 *
 * Countersignature stamps the real signatures onto the STORED document rather
 * than re-rendering it from evidence, so the executed artifact provably
 * contains the exact bytes the consumer signed. That is only possible if the
 * renderer says where the rules landed — the block flows after a
 * variable-length repayment schedule, so its position is not a constant.
 *
 * Null on the `pasq` variant (a quotation is never signed) and on an
 * `execution` render (the rules are replaced by real signatures, so there is
 * nothing left to stamp).
 */
export interface AgreementSignatureAnchors {
  pageIndex: number
  fontSize: number
  consumer: AgreementRuleAnchor
  provider: AgreementRuleAnchor
}

export interface AgreementRenderResult {
  bytes: Buffer
  signatureAnchors: AgreementSignatureAnchors | null
}

/** Renders the document and returns its bytes only. Kept as the entry point for
 *  every caller that does not mint an executed artifact. */
export async function generateCreditAgreementPdf(opts: AgreementOpts): Promise<Buffer> {
  return (await generateCreditAgreementPdfWithAnchors(opts)).bytes
}

export async function generateCreditAgreementPdfWithAnchors(
  opts: AgreementOpts,
): Promise<AgreementRenderResult> {
  const { client, application, calc, product, startDate, maturityDate } = opts
  const lender = requireLenderIdentityFields(opts.lender, ["legalName", "ncrNumber"])
  let signatureAnchors: AgreementSignatureAnchors | null = null
  if (!Number.isFinite(opts.quotePresentedAt.getTime())) {
    throw new Error("Credit agreement requires an exact quotation presentation time")
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.quoteValidUntilDate)) {
    throw new Error("Credit agreement requires an exact quotation-valid-until date")
  }
  const quoteValidUntil = new Date(`${opts.quoteValidUntilDate}T12:00:00.000Z`)
  if (
    !Number.isFinite(quoteValidUntil.getTime())
    || quoteValidUntil.toISOString().slice(0, 10) !== opts.quoteValidUntilDate
  ) {
    throw new Error("Credit agreement quotation-valid-until date is invalid")
  }
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique)
  // Page numbers are drawn at the end via doc.getPages() so the total
  // reflects whatever was actually added (4 normally, plus one for each
  // repayment-schedule continuation page and one if the bundled Credit Life
  // block overflowed p4).

  // Annualisation follows the product's interest MODEL (lib/loan/annualised-rate).
  // Compounding a FLAT / DAILY_ACCRUAL rate quoted an annual cost the consumer
  // cannot incur — their interest is charged once and never capitalised — which
  // overstated the rate on a mandated NCA disclosure.
  const annual = annualisedInterestRate({
    interestRatePm: product.interestRatePm,
    interestModel: product.interestModel,
  })
  const termPct = termInterestPercent({
    principal: calc.principal,
    totalInterest: calc.totalInterest,
  }).toFixed(2)
  const creditLifeElected = opts.creditLife?.elected ?? opts.willAutoBundleCl === true
  if (opts.creditLife?.elected && !opts.creditLife.billing) {
    throw new Error("Accepted credit-life cover requires PASQ-bound billing evidence")
  }
  const schedule = opts.creditLife?.billing
    ? opts.creditLife.billing.schedule.map((item, index) => {
        const contractItem = calc.schedule[index]
        if (
          !contractItem
          || contractItem.installmentNo !== item.installmentNo
          || calc.schedule.length !== opts.creditLife?.billing?.schedule.length
        ) {
          throw new Error(
            "PASQ billing schedule does not match the agreement schedule",
          )
        }
        return {
          installmentNo: item.installmentNo,
          // Billing evidence supplies the premium-inclusive amounts. The final
          // agreement calculator supplies the date-bearing contract schedule,
          // which may have been rebased inside the quote's binding window.
          dueDate: contractItem.dueDate,
          principalDue: item.principalDueCents,
          interestDue: item.interestDueCents,
          feesDue: item.feesDueCents,
          totalDue: item.totalDueCents,
          openingBalance: item.openingBalanceCents,
          closingBalance: item.closingBalanceCents,
        }
      })
    : calc.schedule
  const instalments = describeInstalments(schedule)
  const firstDue = schedule[0]?.dueDate ?? startDate
  const lastDue = schedule[schedule.length - 1]?.dueDate ?? maturityDate
  const creditLifeTotalPremiumCents = creditLifeElected
    ? opts.creditLife?.totalPremiumCents ?? opts.creditLife?.monthlyPremiumCents ?? 0
    : 0

  // ── PAGE 1: PASQ ──────────────────────────────────────────────────────────
  const p1 = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN

  // Header
  const logo = await embedLogo(doc, opts.logo)
  if (logo) {
    const { width: targetWidth, height: targetHeight } = fitLogo(logo, 36, CONTENT_WIDTH)
    p1.drawImage(logo, { x: MARGIN, y: y - targetHeight + 4, width: targetWidth, height: targetHeight })
    y -= targetHeight + 4
  } else {
    drawText(p1, lender.legalName, MARGIN, y, bold, 14, DARK)
    y -= 16
  }
  drawText(p1, `NCR Registration: ${lender.ncrNumber}`, MARGIN, y, regular, 8, GRAY); y -= 12
  y -= 8

  // Title — the document IS a different statutory instrument per variant.
  if (opts.variant === "pasq") {
      // Regulation 29(c): "the quotation must be in a bordered text box and
      // headed \"Quotation\"". Both halves were missing. The border is drawn
      // AFTER the content, outside the existing text positions, so not one
      // character of the legally reviewed wording moves - this adds a heading
      // and a rule, it does not re-lay-out the reviewed document.
      const quoteBoxTop = y + 12
      drawText(p1, "Quotation", MARGIN, y, bold, 11, DARK)
      y -= 15
    drawText(p1, "PRE-AGREEMENT STATEMENT AND QUOTATION", MARGIN, y, bold, 14, ACCENT)
    y -= 16
    drawText(p1, "In terms of Section 92 of the National Credit Act 34 of 2005", MARGIN, y, italic, 9, GRAY)
    y -= 14
    drawText(p1, "[THIS QUOTE IS BINDING FOR 5 DAYS]", MARGIN, y, bold, 9, DARK)
    y -= 13
    drawText(
      p1,
      `Quote presented: ${formatDatePdf(opts.quotePresentedAt)} (SAST).`,
      MARGIN,
      y,
      regular,
      8,
      DARK,
    )
    y -= 11
    drawText(
      p1,
      `NCA Section 92(3): five business days; binding through ${formatDatePdf(quoteValidUntil)} (SAST).`,
      MARGIN,
      y,
      regular,
      8,
      DARK,
    )
      // Border last, with no fill, so it frames the text rather than covering it.
      p1.drawRectangle({
        x: MARGIN - 8,
        y: y - 6,
        width: CONTENT_WIDTH + 16,
        height: quoteBoxTop - (y - 6),
        borderColor: DARK,
        borderWidth: 1,
      })
    y -= 24
  } else {
    drawText(p1, "CREDIT AGREEMENT", MARGIN, y, bold, 14, ACCENT)
    y -= 16
    drawText(p1, "In terms of the National Credit Act 34 of 2005", MARGIN, y, italic, 9, GRAY)
    y -= 14
    // The quotation is NOT re-issued here: it is its own acknowledged
    // document in the signing ceremony. The agreement references it.
    drawText(
      p1,
      `Entered into pursuant to the Pre-Agreement Statement and Quotation presented`,
      MARGIN,
      y,
      regular,
      8,
      DARK,
    )
    y -= 11
    drawText(
      p1,
      `${formatDatePdf(opts.quotePresentedAt)} (SAST) and acknowledged by the consumer.`,
      MARGIN,
      y,
      regular,
      8,
      DARK,
    )
    y -= 24
  }

    // Regulation 29(d)(ii): the proposed DISTRIBUTION of the principal debt,
    // with reference to the items in s.102(1)(b) to (f) of the Act.
    //
    // DERIVED FROM THE FIGURES, not from the payment-mode flag. A first version
    // keyed off initiationFeePayment and got it backwards: it announced the fee
    // as part of the principal debt in DEFERRED mode, where the fee is added to
    // the repayment schedule and the principal debt is purely the cash advanced.
    // Rendering the PDF made it obvious - principal debt and amount advanced
    // both read R5,000 while the line claimed the principal contained a R575
    // fee. On a statutory disclosure that is a false statement about the money.
    //
    // The difference between the principal debt and what the consumer actually
    // receives IS the set of s.102(1) items capitalised into the principal, so
    // computing it that way cannot disagree with the figures printed beside it.
    // The initiation fee is NEVER folded into the interest-bearing principal in
    // either mode - see loan-calculator.ts:206. UPFRONT settles it FROM the cash
    // advance; DEFERRED adds it to the schedule. So no s.102(1)(b) capitalisation
    // occurs, and an earlier draft claiming one was a false statutory statement.
    // What this row must show is where the principal debt GOES.
    const settledFromAdvance = calc.principal - calc.disbursementAmount
    const principalDistributionSummary = settledFromAdvance > 0
      ? `${formatZarPdf(calc.disbursementAmount)} to consumer, `
        + `${formatZarPdf(settledFromAdvance)} settles the initiation fee`
      : `${formatZarPdf(calc.disbursementAmount)} paid to the consumer in full`

  // Value column runs from MARGIN + LABEL_VALUE_OFFSET to the right margin.
  const VALUE_WIDTH = CONTENT_WIDTH - LABEL_VALUE_OFFSET - 4
  const fullAddress = [
    client.addressLine1,
    client.suburb,
    client.city,
    client.province,
    client.postalCode,
  ].filter(Boolean).join(", ")
  const addressLines = fullAddress ? wrapText(fullAddress, bold, 9, VALUE_WIDTH) : ["\u2014"]
  const addressRows: [string, string][] = addressLines.map((line, idx) => [
    idx === 0 ? "Consumer Physical Address" : "",
    line,
  ])

  // Detail table
  const interestModelLabel = product.interestModel.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
  const rows: [string, string][] = [
    ["Credit Provider", lender.legalName],
    ["NCR Registration", lender.ncrNumber],
    ["Consumer Name", `${client.firstName} ${client.lastName}`],
    ["Consumer ID Number", client.idNumber],
      // Form 20's header block asks for the consumer's physical address and
      // contact number alongside the name and ID. Regulation 28(2) permits
      // omitting a section that does not apply, but these always apply - an
      // absent value is missing data, not an inapplicable field, so it renders
      // as an explicit dash rather than vanishing from the disclosure.
      // FULL address, not just line 1 and city. The Client record carries
      // suburb, province and postal code too, and a court-facing disclosure that
      // silently drops half a consumer's address is a defective one.
      //
      // WRAPPED, not truncated. drawLabelValueTable draws each value as a single
      // unwrapped run, so a long address runs past the value column and is cut at
      // the page edge - the same failure that clipped the distribution row, but
      // on free-form data whose length we do not control. Continuation lines are
      // emitted as rows with an empty label.
      ...addressRows,
      ["Consumer Contact Number", client.phone || "—"],
    ["Credit Agreement Type", application.agreementType ?? "—"],
    ["Principal Debt", formatZarPdf(calc.principal)],
      // Regulation 29(d)(ii): the proposed DISTRIBUTION of the principal debt,
      // with reference to the items listed in s.102(1)(b) to (f) of the Act.
      // Listing the components individually (as the rows below do) is not the
      // same as showing how the principal debt is MADE UP, so the distribution
      // is stated explicitly and reconciles to the figure above.
      ["Distribution of Principal Debt", principalDistributionSummary],
    ["Initiation Fee", formatZarPdf(calc.initiationFee)],
    // NCR Circular 15 of 2016: the initiation fee on an unsecured / short-term
    // loan is reflected separately and bears no interest. Disclose how it is
    // paid and the resulting cash advanced to the consumer.
    ["Initiation Fee Payment", opts.initiationFeePayment === "UPFRONT"
      ? "Deducted from amount advanced (interest-free)"
      : "Added to repayment schedule (interest-free)"],
    ["Amount Advanced", formatZarPdf(calc.disbursementAmount)],
    ["Monthly Service Fee", formatZarPdf(product.monthlyServiceFee)],
    ["Interest Rate", `${(product.interestRatePm * 100).toFixed(2)}% per month`],
    // The charge the consumer actually incurs over THIS term, stated before the
    // annualised figure so the annual rate cannot be read as the amount payable.
    ["Interest Over Loan Term", `${termPct}% of the principal debt over ${application.appliedTermDays} days`],
    ["Annual Interest Rate", `${annual.percent.toFixed(1)}% ${annual.basisLabel} — comparison only; term is ${application.appliedTermDays} days`],
    ["Interest Model", interestModelLabel],
    ["Total Interest", formatZarPdf(calc.totalInterest)],
    ...(opts.creditLife
      ? [
          [
            "Credit Life Election",
            creditLifeElected
              ? "ACCEPTED — the offered cover is included"
              : "DECLINED — the offered cover is not included",
          ] as [string, string],
          ["Offered Credit Life Product", opts.creditLife.productName] as [string, string],
          ["Offered Credit Life Insurer", opts.creditLife.insurerName] as [string, string],
          [
            "Offered Credit Life Premium",
            `${formatZarPdf(opts.creditLife.monthlyPremiumCents)} per month`,
          ] as [string, string],
          [
            "Offered Premium Periods",
            String(opts.creditLife.premiumPeriods ?? 1),
          ] as [string, string],
          [
            "Credit Life Premiums Charged",
            formatZarPdf(creditLifeTotalPremiumCents),
          ] as [string, string],
          ...(creditLifeElected
            ? [[
                "Premium Collection",
                "Included in the repayment schedule and in each stated total due",
              ] as [string, string]]
            : []),
        ]
      // No cover was offered (no-offer disclosure): say so, rather than staying
      // silent on credit life. No product, insurer or premium rows: nothing was
      // offered, so naming one would contradict the record (Fair Score audit B6).
      : opts.willAutoBundleCl === true
        ? []
        : [["Credit Life", "Not offered — no credit-life cover is included"] as [string, string]]),
    // NCA s.1 "total cost of credit" includes every fee + charge — the
    // initiation fee always counts, even in UPFRONT mode where it is settled by
    // deduction from the advance rather than collected through the schedule. So
    // this is NOT calc.totalRepayable (which excludes the fee in UPFRONT).
    ["Total Cost of Credit", formatZarPdf(
      calc.principal
      + calc.totalInterest
      + calc.serviceFees
      + calc.initiationFee
      + creditLifeTotalPremiumCents,
    )],
    ["Loan Term", `${application.appliedTermDays} days`],
    // What is actually billed, row by row — not the level-instalment scalar.
    // A DEFERRED initiation fee lands entirely in instalment 1, so quoting only
    // the level figure understates the consumer's first payment.
    ["Instalments", formatInstalmentPattern(instalments, formatZarPdf)],

    ["First Payment Date", formatDatePdf(firstDue)],
    ["Final Payment Date", formatDatePdf(lastDue)],
    ["Maturity Date", formatDatePdf(maturityDate)],
  ]
  y = drawLabelValueTable(p1, y, rows, regular, bold)
  y -= 16

  // Notices — NCA-accurate consumer rights for a money-lending credit
  // agreement. The Section 121 cooling-off/rescission right applies ONLY to a
  // lease or an instalment agreement entered into away from the credit
  // provider's registered business premises (s.121(1)); it does NOT apply to a
  // money loan, so it is not asserted here. The early-settlement right (s.125)
  // does apply; an early-termination charge is permitted only for a LARGE
  // agreement — principal debt over R250 000 (s.125(2)(c)).
  // PAGINATE. These notices are mandatory and drawLabelValueTable does not
  // break pages, so once the detail table grows the block runs past the bottom
  // margin and the LAST notice - s.86 DEBT REVIEW - is drawn off the visible
  // page. It stays in the content stream, so a byte-level test still finds it
  // while a human reading the document does not.
  //
  // This is not hypothetical and it was not pre-existing: adding the Regulation
  // 29 rows made a credit-life PASQ with a long consumer address lose the s.86
  // notice that the same input rendered correctly before. Measured, not assumed.
  //
  // The notices are measured first and moved WHOLE to a continuation page if
  // they do not fit, rather than being allowed to split across the boundary.
  const isLargeAgreement = calc.principal > 25_000_000 // R250 000 in cents
  const notices = [
    // AGREEMENT VARIANT ONLY. This is a term of the credit agreement (s.93),
    // not part of the s.92 quotation — and the Form 20 render is pinned byte
    // for byte because acknowledged PASQ digests depend on it. Adding it to
    // both variants breaks that pin, which is how this scoping was found.
    //
    // NOT statutory wording — our own term, describing how the dates in the
    // table above behave when payout is not same-day. The signed schedule fixes
    // the INTERVALS between payments; the payout date fixes where those
    // intervals start. Without it the printed dates are absolute, so a payout
    // landing a day late silently shortens the consumer's term while the rand
    // interest stays put — R100 over 29 days instead of 30 is 5.17% a month
    // against the Section 103 cap of 5%.
    //
    // Placed in this block deliberately: it is measured and paginated as a unit
    // with the mandatory notices, and an unmeasured paragraph added between the
    // detail table and these notices is exactly what once pushed the Section 86
    // notice off the visible page.
    ...(opts.variant === "agreement"
      ? [`PAYMENT DATES: Payment dates run from the date this loan is paid out to you. The dates shown above assume payout on ${formatDatePdf(startDate)}. If the loan is paid out on a later date, every payment date moves by the same number of days, so the time you have to repay does not change.`]
      : []),
    "EARLY SETTLEMENT (NCA Section 125): You may settle this agreement in full at any time, with or without advance notice. The settlement amount is the unpaid balance of the principal debt together with the interest, fees and charges payable up to the date of settlement.",
    ...(isLargeAgreement
      ? ["As this is a large agreement (principal debt over R250 000), an early-termination charge of up to three months' interest may apply on early settlement, as permitted by Section 125 of the National Credit Act."]
      : []),
    "DEBT REVIEW (NCA Section 86): If you are or become over-indebted, you have the right to apply to a registered debt counsellor for debt review.",
  ]
  const noticeLineCount = notices.reduce(
    (n, notice) => n + wrapText(notice, regular, 8, CONTENT_WIDTH - 16).length,
    0,
  )
  // 12pt per line + 4pt between notices, plus the section title's own height.
  const noticesHeight = noticeLineCount * 12 + notices.length * 4 + 30
  let noticePage = p1
  if (y - noticesHeight < MARGIN) {
    noticePage = doc.addPage([A4_WIDTH, A4_HEIGHT])
    y = A4_HEIGHT - MARGIN
  }
  y = drawSectionTitle(noticePage, y, "IMPORTANT NOTICES", bold)
  for (const notice of notices) {
    const lines = wrapText(notice, regular, 8, CONTENT_WIDTH - 16)
    for (const line of lines) { drawText(noticePage, line, MARGIN + 8, y, regular, 8, DARK); y -= 12 }
    y -= 4
  }

  // ── PAGE 2: REPAYMENT SCHEDULE ────────────────────────────────────────────
  const p2 = doc.addPage([A4_WIDTH, A4_HEIGHT])
  const colDefs = [
    { label: "No.", x: MARGIN, width: 30 },
    { label: "Due Date", x: MARGIN + 35, width: 80 },
    { label: "Principal", x: MARGIN + 120, width: 75 },
    { label: "Interest", x: MARGIN + 200, width: 75 },
    {
      label: creditLifeElected ? "Fees + cover" : "Fees",
      x: MARGIN + 280,
      width: 60,
    },
    { label: "Total Due", x: MARGIN + 345, width: 75 },
    { label: "Balance", x: MARGIN + 425, width: 80 },
  ]

  // Title and header row, repeated on every continuation page.
  const drawScheduleHead = (page: PDFPage): number => {
    let headY = A4_HEIGHT - MARGIN
    drawText(page, "REPAYMENT SCHEDULE", MARGIN, headY, bold, 14, ACCENT); headY -= 24
    drawTableRow(page, headY, colDefs.map(c => ({ text: c.label, x: c.x, width: c.width })), bold, 8, WHITE, ACCENT)
    return headY - 20
  }
  y = drawScheduleHead(p2)

  // 38 rows a page. Continuation pages are added before p3 exists, so they
  // follow p2 directly.
  const scheduleEnd = drawRowsWithContinuation({
    page: p2, y, rows: schedule, floor: MARGIN + 40,
    openContinuation: () => {
      const page = doc.addPage([A4_WIDTH, A4_HEIGHT])
      return { page, y: drawScheduleHead(page) }
    },
    drawRow: (page, rowY, item) => {
      const bg = item.installmentNo % 2 === 0 ? undefined : { ...WHITE }
      drawTableRow(page, rowY, [
        { text: String(item.installmentNo), x: colDefs[0].x, width: colDefs[0].width },
        { text: formatDatePdf(item.dueDate), x: colDefs[1].x, width: colDefs[1].width },
        { text: formatZarPdf(item.principalDue), x: colDefs[2].x, width: colDefs[2].width },
        { text: formatZarPdf(item.interestDue), x: colDefs[3].x, width: colDefs[3].width },
        { text: formatZarPdf(item.feesDue), x: colDefs[4].x, width: colDefs[4].width },
        { text: formatZarPdf(item.totalDue), x: colDefs[5].x, width: colDefs[5].width },
        { text: formatZarPdf(item.closingBalance), x: colDefs[6].x, width: colDefs[6].width },
      ], regular, 8, DARK, bg)
      return rowY - 18
    },
  })
  y = scheduleEnd.y

  // Total row — sum the actual schedule columns so the TOTAL always foots to
  // the printed instalment rows. The Fees column includes the deferred
  // interest-free initiation fee (DEFERRED mode), so it must NOT be hard-wired
  // to calc.serviceFees — that mismatch was the "columns don't add up to
  // the stated Total" defect on the statutory schedule.
  const totPrincipal = schedule.reduce((a, r) => a + r.principalDue, 0)
  const totInterest = schedule.reduce((a, r) => a + r.interestDue, 0)
  const totFees = schedule.reduce((a, r) => a + r.feesDue, 0)
  const totDue = schedule.reduce((a, r) => a + r.totalDue, 0)
  y -= 4
  drawTableRow(scheduleEnd.page, y, [
    { text: "TOTAL", x: colDefs[0].x, width: colDefs[0].width },
    { text: "", x: colDefs[1].x, width: colDefs[1].width },
    { text: formatZarPdf(totPrincipal), x: colDefs[2].x, width: colDefs[2].width },
    { text: formatZarPdf(totInterest), x: colDefs[3].x, width: colDefs[3].width },
    { text: formatZarPdf(totFees), x: colDefs[4].x, width: colDefs[4].width },
    { text: formatZarPdf(totDue), x: colDefs[5].x, width: colDefs[5].width },
    { text: "", x: colDefs[6].x, width: colDefs[6].width },
  ], bold, 8, DARK, ACCENT)

  // ── PAGE 3: TERMS & CONDITIONS ────────────────────────────────────────────
  const p3 = doc.addPage([A4_WIDTH, A4_HEIGHT])
  y = A4_HEIGHT - MARGIN
  drawText(p3, "TERMS AND CONDITIONS", MARGIN, y, bold, 14, ACCENT); y -= 28

  const clauses = [
    "1. LATE PAYMENT: A late payment fee may be charged for each payment not received by the due date, as prescribed by the National Credit Act and Regulations.",
    "2. DEFAULT: You will be in default if payment is not received within 20 business days of the due date. The credit provider may take steps to recover the outstanding amount.",
    "3. SECTION 129 NOTICE: In the event of default, we are required to send you a Section 129 notice before any legal action. This notice will inform you of your rights, including the right to refer the matter to a debt counsellor.",
    "4. COLLECTION COSTS: In the event of default, you may be liable for legal costs on the attorney-client scale, including tracing fees, collection commission, and court costs as permitted by law.",
    "5. CREDIT BUREAU: Your credit information may be reported to registered credit bureaux. Late payments, defaults, and judgments will be recorded and may affect your ability to obtain credit in the future.",
    "6. POPIA: Your personal information is processed in accordance with the Protection of Personal Information Act (POPIA). You have the right to access, correct, and delete your personal information held by us.",
    "7. JURISDICTION: This agreement is subject to the laws of the Republic of South Africa. Any disputes arising from this agreement shall be subject to the jurisdiction of the Magistrate's Court.",
    "8. ENTIRE AGREEMENT: This document, together with the Pre-Agreement Statement and Quotation and the Repayment Schedule, constitutes the entire agreement between the parties.",
    "9. VARIATION: No variation, amendment, or consensual cancellation of this agreement shall be of any force or effect unless reduced to writing and signed by both parties.",
    "10. CONSUMER RIGHTS: You have the right to receive this agreement in an official language that you read or understand, to the extent that is reasonable. You also have the right to receive periodic statements of account.",
  ]
  for (const clause of clauses) {
    const lines = wrapText(clause, regular, 8.5, CONTENT_WIDTH - 8)
    for (const line of lines) { drawText(p3, line, MARGIN + 4, y, regular, 8.5, DARK); y -= 13 }
    y -= 6
    // Never reached by these clauses; guarded in __tests__/agreement-continuation.test.ts ("terms page").
    if (y < MARGIN + 20) break
  }

  // ── PAGE 4: DECLARATION / SIGNATURE PAGE ──────────────────────────────────
  // The quotation is an OFFER, not a contract. It therefore carries no
  // signature block and says so in terms. A consumer handed a document headed
  // "CONSUMER DECLARATION", carrying "I accept the terms and conditions of
  // this credit agreement" over a "Consumer Signature" line, reasonably
  // believes signing it concludes their loan and returns the signed quotation
  // as their agreement.
  // Acceptance is an act of contracting and belongs only on the agreement
  // variant.
  const isPasq = opts.variant === "pasq"
  const p4 = doc.addPage([A4_WIDTH, A4_HEIGHT])
  y = A4_HEIGHT - MARGIN
  y = drawSectionTitle(
    p4,
    y,
    isPasq ? "CONSUMER ACKNOWLEDGEMENT OF RECEIPT" : "CONSUMER DECLARATION",
    bold,
  )
  y -= 4

  if (isPasq) {
    drawText(p4, "THIS IS A QUOTATION - NOT A CREDIT AGREEMENT. DO NOT SIGN IT.", MARGIN + 4, y, bold, 10, DARK)
    y -= 16
    const quotationNotice = wrapText(
      "This document is an offer of credit. It is binding on the credit provider for five business days and places you under no obligation. If you accept it, you will be asked to sign a separate Credit Agreement, which is the only document that creates a loan. Signing this quotation does not create a credit agreement.",
      regular,
      9,
      CONTENT_WIDTH - 8,
    )
    for (const line of quotationNotice) {
      drawText(p4, line, MARGIN + 4, y, regular, 9, DARK)
      y -= 13
    }
    y -= 10
  }

  drawText(p4, `I, ${client.firstName} ${client.lastName} (ID: ${client.idNumber}), hereby confirm that:`, MARGIN + 4, y, regular, 9, DARK)
  y -= 24

  const checkboxes = [
    isPasq
      ? "I have read and understood this Pre-Agreement Statement and Quotation"
      : "I received the Pre-Agreement Statement and Quotation before signing this Credit Agreement",
    "I have read and understood the Repayment Schedule",
    "I have been informed of my right to settle this agreement in full at any time (NCA Section 125)",
    // Accepting the terms is the act of contracting. On a quotation it invites
    // the consumer to accept an offer by signing the offer itself.
    ...(isPasq ? [] : ["I accept the terms and conditions of this credit agreement"]),
    "The information I have provided is true and correct",
  ]
  for (const cb of checkboxes) {
    p4.drawRectangle({ x: MARGIN + 8, y: y - 3, width: 10, height: 10, borderColor: DARK, borderWidth: 0.8 })
    // The agreement-variant PASQ-receipt line wraps; continuation lines stay
    // indented past the checkbox.
    const cbLines = wrapText(cb, regular, 9, CONTENT_WIDTH - 24)
    for (let i = 0; i < cbLines.length; i++) {
      drawText(p4, cbLines[i], MARGIN + 24, y, regular, 9, DARK)
      if (i < cbLines.length - 1) y -= 13
    }
    y -= 22
  }
  y -= 30

  // ── CL DISCLOSURE BLOCK (conditional) ────────────────────────────────────
  // currentPage tracks whichever page the signature block should land on.
  // It starts as p4 and is reassigned to p5 if the CL block overflows.
  let currentPage = p4

  // The signed-off G2 wording's final sentence factually locates the premium
  // disclosure "on page 1 of this agreement" — true only for the PASQ
  // variant. The agreement variant references the separately provided
  // quotation instead. Factual-reference correction only; the substantive
  // Regulation 3/4/7 wording is untouched (compliance re-review flagged in
  // the PR).
  const clDisclosureLines = opts.variant === "pasq"
    ? CL_DISCLOSURE_LINES
    : CL_DISCLOSURE_LINES.map((line, index) =>
        index === CL_DISCLOSURE_LINES.length - 1
          ? "The premium for the bundled credit life cover forms part of the cost of credit and is disclosed separately in the Pre-Agreement Statement and Quotation provided to you before this agreement was entered into."
          : line,
      )

  if (creditLifeElected) {
    // Guard: add a new page if there isn't enough room for the section.
    // Each CL_DISCLOSURE_LINES entry is a full paragraph wrapped by wrapText()
    // into several rendered lines, so count ACTUAL wrapped lines (empty entries
    // are paragraph separators = 1 blank line each). Using entry COUNT here
    // (`.length * 13`) badly under-estimates the height of the reviewed G2
    // wording and would clip the block off the bottom of page 4.
    const wrappedLineCount = clDisclosureLines.reduce(
      (acc, line) => acc + (line === "" ? 1 : wrapText(line, regular, 9, CONTENT_WIDTH - 8).length),
      0,
    )
    const clSectionHeight = 16 + wrappedLineCount * 13 + 16
    if (y < MARGIN + clSectionHeight) {
      // Open a continuation page for the CL block (and signatures)
      const p5 = doc.addPage([A4_WIDTH, A4_HEIGHT])
      y = A4_HEIGHT - MARGIN
      // Draw CL block on new page
      y = drawSectionTitle(p5, y, "CREDIT LIFE DISCLOSURE", bold)
      for (const line of clDisclosureLines) {
        const wrapped = wrapText(line, regular, 9, CONTENT_WIDTH - 8)
        for (const wline of wrapped) {
          drawText(p5, wline, MARGIN + 4, y, regular, 9, DARK)
          y -= 13
        }
      }
      y -= 16
      // Signature block will follow on p5
      currentPage = p5
    } else {
      y = drawSectionTitle(p4, y, "CREDIT LIFE DISCLOSURE", bold)
      for (const line of clDisclosureLines) {
        const wrapped = wrapText(line, regular, 9, CONTENT_WIDTH - 8)
        for (const wline of wrapped) {
          drawText(p4, wline, MARGIN + 4, y, regular, 9, DARK)
          y -= 13
        }
      }
      y -= 16
    }
  }

  // Signature lines — drawn on currentPage (p4 normally, p5 after overflow).
  // The quotation gets none. It is not signed, it is acknowledged, and the
  // acknowledgement is recorded against the exact document digest
  // (pasqAcknowledgedAt / pasqAcknowledgedSha256) — stronger evidence of
  // receipt than a signature on a page, and it cannot be mistaken for
  // concluding the loan.
  if (!isPasq) {
    const sigLines = [
      "Consumer Signature: _______________________________  Date: _______________",
      "Witness Signature:  _______________________________  Date: _______________",
      "Credit Provider Representative: ____________________  Date: _______________",
    ]
    // Measure the rules as they are DRAWN, so countersignature can later stamp
    // the real signatures onto this exact document without re-rendering it.
    // Deliberately derived from the same literals rather than from a
    // restructured copy: the rendered bytes are pinned by hash
    // (see __tests__/creditAgreement.test.ts), so this must add measurement
    // only and change no drawn glyph.
    const ruleAnchor = (line: string, baselineY: number): AgreementRuleAnchor | null => {
      const DATE_LABEL = "  Date: "
      const signatureStart = line.indexOf("_")
      const dateLabelStart = line.indexOf(DATE_LABEL)
      // If the wording is ever edited so these markers are gone, report NO
      // anchors rather than coordinates derived from -1. A garbage anchor would
      // still validate downstream and place a signature somewhere arbitrary on
      // a statutory document; a missing one falls back to an execution page,
      // which is merely uglier. lib/pdf/.claude.md anticipates such edits.
      if (signatureStart < 0 || dateLabelStart <= signatureStart) return null
      const dateStart = dateLabelStart + DATE_LABEL.length
      const width = (from: number, to: number) =>
        regular.widthOfTextAtSize(line.slice(from, to), 9)
      return {
        signatureX: MARGIN + 4 + width(0, signatureStart),
        signatureWidth: width(signatureStart, dateLabelStart),
        dateX: MARGIN + 4 + width(0, dateStart),
        dateWidth: width(dateStart, line.length),
        baselineY,
      }
    }
    const anchorY = [y, y - 36, y - 72]
    const consumerAnchor = ruleAnchor(sigLines[0], anchorY[0])
    const providerAnchor = ruleAnchor(sigLines[2], anchorY[2])
    signatureAnchors = consumerAnchor && providerAnchor
      ? {
          pageIndex: doc.getPages().indexOf(currentPage),
          fontSize: 9,
          consumer: consumerAnchor,
          provider: providerAnchor,
        }
      : null
    for (const line of sigLines) {
      drawText(currentPage, line, MARGIN + 4, y, regular, 9, DARK)
      y -= 36
    }
  }

  y -= 20
  drawText(
    currentPage,
    isPasq
      ? "This quotation is governed by the National Credit Act 34 of 2005"
      : "This agreement is governed by the National Credit Act 34 of 2005",
    MARGIN + 4,
    y,
    italic,
    8,
    GRAY,
  )

  // Stamp "Page N of M" on every page once we know the final total. This
  // MUST stay immediately before doc.save() — any addPage() call after this
  // loop would produce an un-footered last page and re-introduce the
  // "Page X of Y" mismatch this fix is meant to prevent.
  const pages = doc.getPages()
  pages.forEach((p, i) =>
    drawPageNumber(p, i + 1, pages.length, regular, opts.ceremonyMarker))

  const bytes = await doc.save()
  return { bytes: Buffer.from(bytes), signatureAnchors }
}

function wrapText(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, maxWidth: number): string[] {
  const words = text.split(" ")
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const test = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = test
    }
  }
  if (current) lines.push(current)
  return lines
}
