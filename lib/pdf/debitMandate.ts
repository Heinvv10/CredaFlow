import { degrees, PDFDocument, StandardFonts } from "pdf-lib"
import {
  A4_WIDTH, A4_HEIGHT, MARGIN, CONTENT_WIDTH,
  DARK, ACCENT, GRAY, WHITE,
  formatZarPdf, formatDatePdf,
  drawText, drawPageNumber, drawSectionTitle,
  embedLogo, drawLogoChip,
} from "./helpers"
import { requireLenderIdentityFields, type LenderIdentity } from "@/lib/config/identity-schema"

interface DebitMandateOpts {
  lender: Pick<LenderIdentity, "legalName" | "ncrNumber" | "registeredOfficeLines">
  /** The creditor's collection account (deployment env, lib/config/debit-mandate.ts). */
  creditorBank: {
    bankName: string
    accountNumber: string
    branchCode: string
  }
  /** Letterhead logo, PNG bytes. Absent → text header. */
  logo?: Uint8Array
  client: {
    firstName: string
    lastName: string
    idNumber: string
    phone?: string
    email?: string
    bankName: string
    branchCode: string
    accountNumber: string
    accountType: "CHEQUE" | "SAVINGS"
  }
  loan: {
    reference: string
    paymentFrequency: "ONCE_OFF" | "MONTHLY"
    recurringDebitAmount: number | null
    firstDebitAmount: number
    firstDebitInitiationFee: number
    firstDebitDate: Date
    repaymentDayOfMonth?: number
  }
  generatedAt?: Date
  authorization?: {
    signedAt: Date
    method: "portal"
    signature: string
    signatureSha256: string
    evidenceSha256: string
    sourceDocumentSha256: string
  }
}

// Keyed by the full account-type union so adding a type fails the build here
// rather than silently printing the wrong one on a bank-facing mandate.
const DEBIT_MANDATE_ACCOUNT_TYPE_LABELS: Record<
  DebitMandateOpts["client"]["accountType"],
  string
> = {
  CHEQUE: "Cheque / Current",
  SAVINGS: "Savings",
}

export async function generateDebitMandatePdf(opts: DebitMandateOpts): Promise<Buffer> {
  const { creditorBank, client, loan, authorization } = opts
  const accountHolderName = `${client.firstName.trim()} ${client.lastName.trim()}`.trim()
  // The registered creditor the mandate names; throws LenderIdentityError.
  const lender = requireLenderIdentityFields(opts.lender, ["legalName", "ncrNumber", "registeredOfficeLines"])
  if (
    !accountHolderName
    || accountHolderName.length > 120
    || !client.bankName.trim()
    || client.bankName.length > 80
    || !creditorBank.bankName.trim()
    || creditorBank.bankName.length > 80
  ) {
    throw new Error("Debit-mandate identity or banking text exceeds the safe document layout.")
  }
  if (
    (loan.paymentFrequency === "MONTHLY" && loan.recurringDebitAmount === null)
    || (loan.paymentFrequency === "ONCE_OFF" && loan.recurringDebitAmount !== null)
  ) {
    throw new Error("Debit-mandate payment frequency does not match its recurring amount.")
  }
  const doc = await PDFDocument.create()
  const generatedAt = opts.generatedAt ?? new Date()
  doc.setCreationDate(generatedAt)
  doc.setModificationDate(generatedAt)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique)

  let page = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN

  const barHeight = 60
  const logo = await embedLogo(doc, opts.logo)
  const markDraftPage = () => {
    if (authorization) return
    // A preview does not capture or embed a consumer signature. Never let any
    // page of its output masquerade as an operative debit authority.
    page.drawText("DRAFT - NOT AUTHORISED", {
      x: 78,
      y: 350,
      size: 42,
      font: bold,
      color: GRAY,
      rotate: degrees(35),
      opacity: 0.16,
    })
  }
  const drawCreditorHeader = () => {
    page.drawRectangle({ x: 0, y: A4_HEIGHT - barHeight, width: A4_WIDTH, height: barHeight, color: DARK })
    if (logo) {
      const ncrLine = `NCR Reg: ${lender.ncrNumber}`
      const textX = drawLogoChip(page, logo, MARGIN, A4_HEIGHT, barHeight, regular.widthOfTextAtSize(ncrLine, 8))
      drawText(page, ncrLine, textX, A4_HEIGHT - 36, regular, 8, WHITE)
    } else {
      drawText(page, lender.legalName, MARGIN, A4_HEIGHT - 36, bold, 14, ACCENT)
      drawText(page, `NCR Reg: ${lender.ncrNumber}`, MARGIN, A4_HEIGHT - 52, regular, 8, WHITE)
    }
  }
  markDraftPage()

  drawCreditorHeader()
  y = A4_HEIGHT - 80

  drawText(page, "DEBIT ORDER PAYMENT AUTHORITY", MARGIN, y, bold, 14, ACCENT)
  drawText(
    page,
    authorization ? "SIGNED ELECTRONICALLY" : "DRAFT - NOT SIGNED",
    A4_WIDTH - MARGIN - (authorization ? 132 : 112),
    y,
    bold,
    9,
    DARK,
  )
  y -= 16
  drawText(page, "In terms of the National Credit Act 34 of 2005 and the Payment Association of South Africa (PASA) rules", MARGIN, y, italic, 8, GRAY); y -= 24

  drawText(page, `Loan Reference: ${loan.reference}`, MARGIN, y, bold, 9, DARK)
  drawText(page, `Date: ${formatDatePdf(generatedAt)}`, A4_WIDTH - MARGIN - 120, y, regular, 9, GRAY)
  y -= 20

  y = drawSectionTitle(page, y, "1. DEBIT AUTHORITY INSTRUCTION", bold)
  const paymentInstruction = loan.paymentFrequency === "ONCE_OFF"
    ? `The payment instruction will be a once-off debit of ${formatZarPdf(loan.firstDebitAmount)} on ${formatDatePdf(loan.firstDebitDate)}, or such other amount as may be due.`
    : `The regular payment instruction will currently be ${formatZarPdf(loan.recurringDebitAmount!)} per month. The first payment instruction will be ${formatZarPdf(loan.firstDebitAmount)} on ${formatDatePdf(loan.firstDebitDate)}, or such other amount as may be due.`
  const instrText = `I/We hereby authorise ${lender.legalName} ("the creditor") to issue and deliver payment instructions to my/our bank for collection against my/our account. ${paymentInstruction} This authority is to remain in force until cancelled in writing with 30 days' notice.`
  const instrLines = wrapTextToWidth(instrText, regular, 9, CONTENT_WIDTH - 8)
  for (const line of instrLines) { drawText(page, line, MARGIN + 4, y, regular, 9, DARK); y -= 13 }
  y -= 10

  y = drawSectionTitle(page, y, "2. CONSUMER BANKING DETAILS", bold)
  const bankFields: [string, string][] = [
    ["Account Holder Name", accountHolderName],
    ["ID Number", client.idNumber],
    ["Bank Name", client.bankName],
    ["Branch Code", client.branchCode],
    ["Account Number", client.accountNumber],
    // Exhaustive map, not a two-way ternary: this field states the consumer's
    // account type to their bank, so an unlisted type must never fall through
    // to a wrong-but-plausible label.
    ["Account Type", DEBIT_MANDATE_ACCOUNT_TYPE_LABELS[client.accountType]],
  ]
  for (const [label, value] of bankFields) {
    drawText(page, `${label}:`, MARGIN + 4, y, bold, 9, DARK)
    const valueLines = wrapTextToWidth(value, regular, 9, CONTENT_WIDTH - 164)
    valueLines.forEach((line, index) => {
      drawText(page, line, MARGIN + 160, y - index * 11, regular, 9, DARK)
    })
    y -= Math.max(15, valueLines.length * 11 + 4)
  }
  y -= 6

  y = drawSectionTitle(page, y, "3. DEBIT ORDER DETAILS", bold)
  const amountFields: [string, string][] = loan.paymentFrequency === "ONCE_OFF"
    ? [["Once-Off Debit Amount", formatZarPdf(loan.firstDebitAmount)]]
    : [
        ["Regular Recurring Debit", formatZarPdf(loan.recurringDebitAmount!)],
        ["First Debit Amount", formatZarPdf(loan.firstDebitAmount)],
      ]
  const debitFields: [string, string][] = [
    ...amountFields,
    ...(loan.firstDebitInitiationFee > 0
      ? [["Initiation Fee Included in First Debit", formatZarPdf(loan.firstDebitInitiationFee)] as [string, string]]
      : []),
    ["First Debit Date", formatDatePdf(loan.firstDebitDate)],
    ["Debit Day of Month", loan.repaymentDayOfMonth ? String(loan.repaymentDayOfMonth) : "As per repayment schedule"],
    ["Frequency", loan.paymentFrequency === "ONCE_OFF" ? "Once-off" : "Monthly"],
    ["Reference", loan.reference],
  ]
  for (const [label, value] of debitFields) {
    drawText(page, `${label}:`, MARGIN + 4, y, bold, 9, DARK)
    drawText(page, value, MARGIN + 250, y, regular, 9, DARK)
    y -= 15
  }
  y -= 6

  y = drawSectionTitle(page, y, "4. CREDITOR COLLECTION DETAILS", bold)
  const creditorFields: [string, string][] = [
    ["Company Name", lender.legalName],
    ["Bank", creditorBank.bankName],
    ["Branch Code", creditorBank.branchCode],
    ["Account Number", creditorBank.accountNumber],
    ["Reference to Use", loan.reference],
  ]
  for (const [label, value] of creditorFields) {
    drawText(page, `${label}:`, MARGIN + 4, y, bold, 9, DARK)
    const valueLines = wrapTextToWidth(value, regular, 9, CONTENT_WIDTH - 164)
    valueLines.forEach((line, index) => {
      drawText(page, line, MARGIN + 160, y - index * 11, regular, 9, DARK)
    })
    y -= Math.max(15, valueLines.length * 11 + 4)
  }
  drawText(page, "Registered Address:", MARGIN + 4, y, bold, 9, DARK)
  const registeredAddressLines = wrapTextToWidth(
    lender.registeredOfficeLines.join(", "),
    regular,
    8.5,
    CONTENT_WIDTH - 170,
  )
  for (const line of registeredAddressLines) {
    drawText(page, line, MARGIN + 160, y, regular, 8.5, DARK)
    y -= 11
  }
  y -= 8

  // Keep the rights and both signature rows together. Long but accepted names
  // can add rows to sections 2/4; without a real page break, the witness row
  // collides with the page-number footer or is clipped off the A4 media box.
  const RIGHTS_TO_WITNESS_BASELINE = 162
  const FOOTER_CLEARANCE = 38
  if (y - RIGHTS_TO_WITNESS_BASELINE < FOOTER_CLEARANCE) {
    page = doc.addPage([A4_WIDTH, A4_HEIGHT])
    markDraftPage()
    drawCreditorHeader()
    y = A4_HEIGHT - 80
    drawText(page, "DEBIT ORDER PAYMENT AUTHORITY (CONTINUED)", MARGIN, y, bold, 14, ACCENT)
    drawText(
      page,
      authorization ? "SIGNED ELECTRONICALLY" : "DRAFT - NOT SIGNED",
      A4_WIDTH - MARGIN - (authorization ? 132 : 112),
      y,
      bold,
      9,
      DARK,
    )
    y -= 28
  }

  y = drawSectionTitle(page, y, "5. CONSUMER RIGHTS (PASA)", bold)
  const rights = [
    "- You may cancel this debit order instruction by giving 30 days written notice to the creditor.",
    "- You may dispute any unauthorised debit by contacting your bank within 40 days of the debit.",
    "- Cancellation of this mandate does not cancel your obligation to repay the loan.",
  ]
  for (const right of rights) { drawText(page, right, MARGIN + 4, y, regular, 8.5, DARK); y -= 12 }
  y -= 10

  y = drawSectionTitle(page, y, "6. AUTHORISATION", bold)
  drawText(page, "By signing below I confirm I am the authorised account holder and I authorise the above debit.", MARGIN + 4, y, italic, 9, GRAY); y -= 28
  if (authorization) {
    drawText(page, "Consumer Signature:", MARGIN + 4, y, regular, 9, DARK)
    if (authorization.signature.startsWith("data:image/png;base64,")) {
      const signatureBytes = Buffer.from(
        authorization.signature.slice("data:image/png;base64,".length),
        "base64",
      )
      const signatureImage = await doc.embedPng(signatureBytes)
      const scale = Math.min(250 / signatureImage.width, 42 / signatureImage.height)
      page.drawImage(signatureImage, {
        x: MARGIN + 105,
        y: y - 12,
        width: signatureImage.width * scale,
        height: signatureImage.height * scale,
      })
    } else {
      drawText(page, authorization.signature, MARGIN + 105, y, italic, 11, DARK)
    }
    drawText(
      page,
      `Date: ${formatDatePdf(authorization.signedAt)}`,
      MARGIN + 360,
      y,
      regular,
      9,
      DARK,
    )
    y -= 28
    drawText(
      page,
      `Electronic evidence: ${authorization.signatureSha256.slice(0, 16)}... / Terms: ${authorization.evidenceSha256.slice(0, 16)}... / Draft: ${authorization.sourceDocumentSha256.slice(0, 16)}...`,
      MARGIN + 4,
      y,
      regular,
      7,
      GRAY,
    )
    y -= 18
  } else {
    drawText(page, "Consumer Signature: _______________________________", MARGIN + 4, y, regular, 9, DARK)
    drawText(page, "Date: _______________", MARGIN + 360, y, regular, 9, DARK); y -= 28
  }
  drawText(page, "Witness Signature:  _______________________________", MARGIN + 4, y, regular, 9, DARK)
  drawText(page, "Date: _______________", MARGIN + 360, y, regular, 9, DARK); y -= 28

  const pages = doc.getPages()
  pages.forEach((currentPage, index) => {
    drawPageNumber(currentPage, index + 1, pages.length, regular)
  })

  return Buffer.from(await doc.save())
}

export function wrapTextToWidth(
  text: string,
  font: { widthOfTextAtSize: (t: string, s: number) => number },
  size: number,
  maxWidth: number,
): string[] {
  if (!(maxWidth > 0)) throw new Error("PDF text width must be positive")
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      if (current) {
        lines.push(current)
        current = ""
      }
      const characters = Array.from(word)
      let offset = 0
      while (offset < characters.length) {
        let low = 1
        let high = characters.length - offset
        let fittingLength = 0
        while (low <= high) {
          const middle = Math.floor((low + high) / 2)
          const candidate = characters.slice(offset, offset + middle).join("")
          if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
            fittingLength = middle
            low = middle + 1
          } else {
            high = middle - 1
          }
        }
        if (fittingLength === 0) {
          throw new Error("A debit-mandate character exceeds the available PDF width.")
        }
        const chunk = characters.slice(offset, offset + fittingLength).join("")
        offset += fittingLength
        if (offset < characters.length) lines.push(chunk)
        else current = chunk
      }
      continue
    }
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
