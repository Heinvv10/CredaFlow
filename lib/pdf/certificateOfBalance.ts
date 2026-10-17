import { PDFDocument, StandardFonts } from "pdf-lib"
import {
  A4_WIDTH, A4_HEIGHT, MARGIN, CONTENT_WIDTH,
  DARK, ACCENT, GRAY, WHITE,
  formatZarPdf, formatDatePdf,
  drawText, drawPageNumber, drawSectionTitle,
  embedLogo, drawLogoChip,
} from "./helpers"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireLenderIdentityFields, type LenderIdentity } from "@/lib/config/identity-schema"

interface CobOpts {
  lender: Pick<LenderIdentity, "legalName" | "ncrNumber">
  /** Letterhead logo, PNG bytes. Absent → text header. */
  logo?: Uint8Array
  client: { firstName: string; lastName: string; idNumber: string; addressLine1?: string; city?: string }
  loan: {
    reference: string
    startDate: Date
    maturityDate: Date
    principal: number
    totalRepayable: number
    totalPaid: number
    outstandingPrincipal: number
    arrearsAmount: number
    daysInArrears: number
    interestRatePm: number
    lastPaymentDate?: Date | null
    lastPaymentAmount?: number | null
  }
  asAt?: Date
  /** cash received, when Loan.totalPaid is not it (lib/loan/charges-summary.ts certificatePaidToDate) */
  paymentsReceived?: number
  /**
   * What it takes to settle today, itemised: the amount the receipt paths
   * accept to close the loan (lib/loan/charges-summary.ts). Absent → the
   * certificate renders as before.
   */
  settlement?: {
    /** cash received on the loan, excluding reversals and waivers; absent: Loan.totalPaid */
    paymentsReceived?: number
    /** contractual interest and fees within the settlement */
    interestAndFeesOutstanding: number
    /** default charges owed, one line per type */
    charges: Array<{ label: string; amount: number }>
    totalToSettle: number
  }
}

export async function generateCertificateOfBalancePdf(opts: CobOpts): Promise<Buffer> {
  const { client, loan } = opts
  const lender = requireLenderIdentityFields(opts.lender, ["legalName", "ncrNumber"])
  const asAt = opts.asAt ?? new Date()
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique)

  const page = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN

  // Header
  const barHeight = 70
  page.drawRectangle({ x: 0, y: A4_HEIGHT - barHeight, width: A4_WIDTH, height: barHeight, color: DARK })
  const logo = await embedLogo(doc, opts.logo)
  if (logo) {
    const ncrLine = `NCR Reg: ${lender.ncrNumber}`
    const textX = drawLogoChip(page, logo, MARGIN, A4_HEIGHT, barHeight, regular.widthOfTextAtSize(ncrLine, 9))
    drawText(page, ncrLine, textX, A4_HEIGHT - 36, regular, 9, WHITE)
  } else {
    drawText(page, lender.legalName, MARGIN, A4_HEIGHT - 36, bold, 16, ACCENT)
    drawText(page, `NCR Reg: ${lender.ncrNumber}`, MARGIN, A4_HEIGHT - 54, regular, 9, WHITE)
  }
  y = A4_HEIGHT - 90

  drawText(page, "CERTIFICATE OF OUTSTANDING BALANCE", MARGIN, y, bold, 14, ACCENT); y -= 16
  drawText(page, "Issued in terms of Section 112 of the National Credit Act 34 of 2005", MARGIN, y, italic, 8, GRAY); y -= 8
  drawText(page, `As at: ${formatDatePdf(asAt)}`, MARGIN, y - 10, bold, 9, DARK)
  drawText(page, `Certificate No: COB-${loan.reference}-${sastCalendarDate(asAt).replaceAll("-", "")}`, A4_WIDTH - MARGIN - 220, y - 10, regular, 8, GRAY)
  y -= 32

  // Parties
  y = drawSectionTitle(page, y, "1. PARTIES", bold)
  const partyCols: [string, string][] = [
    ["Credit Provider", lender.legalName],
    ["NCR Registration", lender.ncrNumber],
    ["Consumer", `${client.firstName} ${client.lastName}`],
    ["Consumer ID", client.idNumber],
    ["Consumer Address", client.addressLine1 ? `${client.addressLine1}${client.city ? `, ${client.city}` : ""}` : "—"],
  ]
  for (const [label, value] of partyCols) {
    drawText(page, `${label}:`, MARGIN + 4, y, bold, 9, DARK)
    drawText(page, value, MARGIN + 150, y, regular, 9, DARK)
    y -= 16
  }
  y -= 4

  // Loan details
  y = drawSectionTitle(page, y, "2. CREDIT AGREEMENT DETAILS", bold)
  const loanCols: [string, string][] = [
    ["Agreement Reference", loan.reference],
    ["Agreement Date", formatDatePdf(loan.startDate)],
    ["Maturity Date", formatDatePdf(loan.maturityDate)],
    ["Original Principal", formatZarPdf(loan.principal)],
    ["Total Amount Repayable", formatZarPdf(loan.totalRepayable)],
    ["Interest Rate", `${(loan.interestRatePm * 100).toFixed(2)}% per month`],
  ]
  for (const [label, value] of loanCols) {
    drawText(page, `${label}:`, MARGIN + 4, y, bold, 9, DARK)
    drawText(page, value, MARGIN + 180, y, regular, 9, DARK)
    y -= 16
  }
  y -= 4

  // Balance certificate - highlighted
  y = drawSectionTitle(page, y, "3. CERTIFICATE OF OUTSTANDING BALANCE", bold)

  const settlement = opts.settlement
  const balanceCols: [string, string, boolean][] = [
    // Loan.totalPaid excludes money that paid default charges, so the
    // certificate states the cash received when it has it.
    ["Total Paid to Date", formatZarPdf(settlement?.paymentsReceived ?? opts.paymentsReceived ?? loan.totalPaid), false],
    ["Outstanding Principal Balance", formatZarPdf(loan.outstandingPrincipal), true],
    ...(settlement
      ? [
          ["Interest and Fees Outstanding", formatZarPdf(settlement.interestAndFeesOutstanding), false],
          ...settlement.charges.map((charge) => [`${charge.label} Outstanding`, formatZarPdf(charge.amount), false]),
          ["Total Amount to Settle", formatZarPdf(settlement.totalToSettle), true],
        ] as [string, string, boolean][]
      : []),
    ["Arrears Amount", loan.arrearsAmount > 0 ? formatZarPdf(loan.arrearsAmount) : "Nil", loan.arrearsAmount > 0],
    ["Days in Arrears", loan.daysInArrears > 0 ? String(loan.daysInArrears) : "0 (not in arrears)", loan.daysInArrears > 0],
    ["Last Payment Date", loan.lastPaymentDate ? formatDatePdf(loan.lastPaymentDate) : "No payments recorded", false],
    ["Last Payment Amount", loan.lastPaymentAmount ? formatZarPdf(loan.lastPaymentAmount) : "—", false],
  ]
  // 90pt for the original six rows, growing with the settlement lines.
  const boxHeight = balanceCols.length * 15
  page.drawRectangle({ x: MARGIN, y: y - (boxHeight - 10), width: CONTENT_WIDTH, height: boxHeight, color: GRAY, opacity: 0.07 })
  for (const [label, value, highlight] of balanceCols) {
    drawText(page, `${label}:`, MARGIN + 8, y, bold, 9, highlight ? ACCENT : DARK)
    drawText(page, value, MARGIN + 200, y, bold, 9, highlight ? ACCENT : DARK)
    y -= 18
  }
  y -= 8

  // Certification
  y = drawSectionTitle(page, y, "4. CERTIFICATION", bold)
  const certText = `This certificate is issued by ${lender.legalName} and confirms that the outstanding balance on credit agreement ${loan.reference} as at ${formatDatePdf(asAt)} is ${formatZarPdf(settlement?.totalToSettle ?? loan.outstandingPrincipal)}. This certificate is valid for 30 days from the date of issue. In the event of any dispute, the credit provider's records shall prevail unless successfully challenged.`
  const certLines = wrapText(certText, regular, 9, CONTENT_WIDTH - 8)
  for (const line of certLines) { drawText(page, line, MARGIN + 4, y, regular, 9, DARK); y -= 13 }
  y -= 16

  // Authorised signatory
  drawText(page, "Authorised Signatory: _______________________________", MARGIN + 4, y, regular, 9, DARK)
  drawText(page, "Date: _______________", MARGIN + 360, y, regular, 9, DARK); y -= 20
  drawText(page, lender.legalName, MARGIN + 4, y, italic, 8, GRAY); y -= 12
  drawText(page, "This certificate is issued in terms of section 112 of the National Credit Act 34 of 2005.", MARGIN + 4, y, italic, 8, GRAY)

  drawPageNumber(page, 1, 1, regular)
  return Buffer.from(await doc.save())
}

function wrapText(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, maxWidth: number): string[] {
  const words = text.split(" ")
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const test = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) { lines.push(current); current = word }
    else current = test
  }
  if (current) lines.push(current)
  return lines
}
