import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import {
  A4_WIDTH, A4_HEIGHT, MARGIN, CONTENT_WIDTH,
  DARK, ACCENT, GRAY,
  formatZarPdf, formatDatePdf,
  drawText, drawPageNumber, embedLogo, fitLogo,
} from "./helpers"
import { LenderIdentityError, requireLenderIdentityFields, type LenderIdentity } from "@/lib/config/identity-schema"

/**
 * Section 129 Notice PDF — the operative legal artefact.
 *
 * NCA-mandated wording (the 129(1)(a) preamble, the enumerated options
 * including debt counsellor / ADR / consumer court / ombud, the
 * 10-business-day warning, and the dispute-in-error clause) is verbatim
 * and may not be paraphrased. Update this file only with legal sign-off.
 *
 * Letterhead branding: the lender's logo when given (top-left), else its
 * name and tagline; registered office block (top-right); regulatory
 * compliance strip. Every identity value — name, registration numbers,
 * office, collections contacts — is the lender's own, re-validated here.
 */

/** The identity the notice prints. */
export const SECTION_129_IDENTITY_FIELDS = [
  "legalName", "ncrNumber", "fspNumber", "companyRegNumber", "registeredOfficeLines",
  "collectionsEmail", "collectionsPhone", "collectionsPhoneSecondary", "brandTagline",
] as const

interface Section129Opts {
  lender: Pick<LenderIdentity, (typeof SECTION_129_IDENTITY_FIELDS)[number]>
  /** Letterhead logo, PNG bytes. Absent → text header. */
  logo?: Uint8Array
  client: { firstName: string; lastName: string; idNumber: string; identityLabel?: "ID" | "Registration no."; addressLine1?: string; city?: string }
  loan: {
    reference: string
    /** arrears the notice states — charge-inclusive when default charges are on */
    arrearsAmount: number
    outstandingPrincipal: number
    daysInArrears: number
    /**
     * What settles the loan today, charges included (lib/loan/charges-summary.ts).
     * Absent on notices rendered before it existed, which state the principal.
     */
    totalOutstanding?: number
    /** default charges included in the two figures above */
    chargesOutstanding?: number
  }
  noticeDate?: Date
}

const RED = rgb(220 / 255, 38 / 255, 38 / 255)
const CREAM = rgb(250 / 255, 248 / 255, 240 / 255)

export async function generateSection129Pdf(opts: Section129Opts): Promise<Buffer> {
  const { client, loan } = opts
  // Before anything is drawn: a notice naming the wrong lender is worse than none.
  const lender = requireLenderIdentityFields(opts.lender, SECTION_129_IDENTITY_FIELDS)
  const totalOutstanding = loan.totalOutstanding ?? loan.outstandingPrincipal
  const noticeDate = opts.noticeDate ?? new Date()
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique)

  const logo = await embedLogo(doc, opts.logo)

  const page = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN

  // ─── Letterhead ─────────────────────────────────────────────────────────
  const headerTop = A4_HEIGHT - MARGIN
  const headerBottom = A4_HEIGHT - MARGIN - 70

  // The letterhead (logo, or name and tagline) sits left of the registered
  // office block and must never print over it.
  const officeLeft = A4_WIDTH - MARGIN - Math.max(...lender.registeredOfficeLines.map((line) => regular.widthOfTextAtSize(line, 8.5)))
  const room = officeLeft - MARGIN - 12

  if (logo) {
    // 56pt tall unless that is too wide for the room, then scaled down and
    // centred in the same 56pt band.
    const { width: targetWidth, height: targetHeight } = fitLogo(logo, 56, room)
    page.drawImage(logo, {
      x: MARGIN,
      y: headerBottom + 4 + (56 - targetHeight) / 2,
      width: targetWidth,
      height: targetHeight,
    })
  } else {
    // A name that fits prints as approved (16pt, one line, tagline 14pt
    // below); a longer one steps down to 9pt and wraps.
    const taglineLines = lender.brandTagline ? wrapText(lender.brandTagline, italic, 9, room) : []
    let layout: { size: number; nameLines: string[] } | null = null
    for (let size = 16; size >= 9 && !layout; size--) {
      const nameLines = wrapText(lender.legalName, bold, size, room)
      const height = (size + 2) * nameLines.length + (taglineLines.length ? 14 + 11 * (taglineLines.length - 1) : 0)
      // wrapText cannot break a single word, so every line is measured.
      const fits = nameLines.every((line) => bold.widthOfTextAtSize(line, size) <= room)
        && taglineLines.every((line) => italic.widthOfTextAtSize(line, 9) <= room)
        && height <= 66
      if (fits && (size < 16 || nameLines.length === 1)) layout = { size, nameLines }
    }
    if (!layout) {
      throw new LenderIdentityError(
        ["legalName", "brandTagline", "registeredOffice"],
        "The legal name and tagline do not fit the Section 129 letterhead beside the registered office.",
      )
    }
    let nameY = headerTop - (layout.size + 2)
    for (const [i, line] of layout.nameLines.entries()) {
      if (i > 0) nameY -= layout.size + 2
      drawText(page, line, MARGIN, nameY, bold, layout.size, ACCENT)
    }
    let taglineY = nameY - 14
    for (const line of taglineLines) {
      drawText(page, line, MARGIN, taglineY, italic, 9, GRAY)
      taglineY -= 11
    }
  }

  // Top-right registered office block.
  const rightX = A4_WIDTH - MARGIN
  let officeY = headerTop - 8
  for (const line of lender.registeredOfficeLines) {
    const width = regular.widthOfTextAtSize(line, 8.5)
    drawText(page, line, rightX - width, officeY, regular, 8.5, DARK)
    officeY -= 11
  }

  // Compliance strip under letterhead.
  page.drawLine({ start: { x: MARGIN, y: headerBottom }, end: { x: A4_WIDTH - MARGIN, y: headerBottom }, thickness: 1.2, color: ACCENT })
  const stripText = `Registered Credit Provider — NCR ${lender.ncrNumber}    ·    Authorised Financial Services Provider — FSP ${lender.fspNumber}    ·    Reg. No. ${lender.companyRegNumber}`
  drawText(page, stripText, MARGIN, headerBottom - 12, regular, 7.5, GRAY)

  y = headerBottom - 32

  // ─── Title ──────────────────────────────────────────────────────────────
  drawText(page, "NOTICE IN TERMS OF SECTION 129(1)(a)", MARGIN, y, bold, 13, RED); y -= 14
  drawText(page, "NATIONAL CREDIT ACT 34 OF 2005", MARGIN, y, bold, 11, DARK); y -= 22

  // ─── Date + addressee ───────────────────────────────────────────────────
  drawText(page, `Date: ${formatDatePdf(noticeDate)}`, A4_WIDTH - MARGIN - 150, y + 14, regular, 9, DARK)
  drawText(page, "To:", MARGIN, y, bold, 9, DARK)
  drawText(page, `${client.firstName} ${client.lastName}`, MARGIN + 24, y, regular, 9, DARK); y -= 13
  drawText(page, `${client.identityLabel ?? "ID"}: ${client.idNumber}`, MARGIN + 24, y, regular, 9, DARK); y -= 13
  if (client.addressLine1) {
    drawText(page, `${client.addressLine1}${client.city ? `, ${client.city}` : ""}`, MARGIN + 24, y, regular, 9, DARK)
    y -= 13
  }
  y -= 10

  // ─── Warning box ────────────────────────────────────────────────────────
  page.drawRectangle({ x: MARGIN, y: y - 50, width: CONTENT_WIDTH, height: 56, color: rgb(254/255, 242/255, 242/255), borderColor: RED, borderWidth: 1 })
  drawText(page, "WARNING:  YOUR ACCOUNT IS IN ARREARS — IMMEDIATE ATTENTION REQUIRED", MARGIN + 8, y - 14, bold, 9, RED)
  drawText(page, "This is a formal notice in terms of Section 129 of the NCA. You have the right to refer this matter", MARGIN + 8, y - 28, regular, 8.5, DARK)
  drawText(page, "to a debt counsellor, alternative dispute resolution agent, or consumer court before legal action.", MARGIN + 8, y - 40, regular, 8.5, DARK)
  y -= 68

  // ─── Account details ────────────────────────────────────────────────────
  const fields: [string, string][] = [
    ["Loan Reference", loan.reference],
    ["Arrears Amount", formatZarPdf(loan.arrearsAmount)],
    ["Outstanding Balance", formatZarPdf(totalOutstanding)],
    ["Days in Arrears", `${loan.daysInArrears} days`],
    ...(loan.chargesOutstanding
      ? [["Default Charges (included above)", formatZarPdf(loan.chargesOutstanding)]] as [string, string][]
      : []),
  ]
  // 76pt for the original four rows; 16pt more per extra line.
  const detailsHeight = 76 + (fields.length - 4) * 16
  page.drawRectangle({ x: MARGIN, y: y - (detailsHeight - 6), width: CONTENT_WIDTH, height: detailsHeight, color: CREAM, borderColor: ACCENT, borderWidth: 0.5 })
  let detailsY = y - 12
  for (const [label, value] of fields) {
    drawText(page, `${label}:`, MARGIN + 10, detailsY, bold, 9, DARK)
    drawText(page, value, MARGIN + 170, detailsY, regular, 9, DARK)
    detailsY -= 16
  }
  y -= 84 + (fields.length - 4) * 16

  // ─── Statutory body (verbatim NCA wording — DO NOT paraphrase) ─────────
  const paras = [
    `In terms of section 129(1)(a) of the National Credit Act, we hereby notify you that ${loan.reference} is in arrears in the amount of ${formatZarPdf(loan.arrearsAmount)}. Your total outstanding obligation is ${formatZarPdf(totalOutstanding)}.`,
    "We urge you to contact us immediately to resolve this arrears. You have the following options available to you:",
  ]
  for (const para of paras) {
    const lines = wrapText(para, regular, 9, CONTENT_WIDTH - 8)
    for (const line of lines) { drawText(page, line, MARGIN + 4, y, regular, 9, DARK); y -= 13 }
    y -= 6
  }

  const options = [
    "1. Contact our offices to make immediate payment or a payment arrangement.",
    "2. Apply for debt review in terms of section 86 of the NCA by contacting a registered debt counsellor.",
    "3. Refer the matter to an alternative dispute resolution agent.",
    "4. Approach the consumer court or ombud with jurisdiction.",
  ]
  for (const opt of options) {
    const lines = wrapText(opt, regular, 9, CONTENT_WIDTH - 20)
    for (const line of lines) { drawText(page, line, MARGIN + 12, y, regular, 9, DARK); y -= 13 }
    y -= 4
  }
  y -= 6

  drawText(page, "PLEASE NOTE: If no response is received within 10 business days of this notice, we may proceed", MARGIN + 4, y, bold, 8.5, RED); y -= 13
  drawText(page, "with legal action to recover the outstanding debt, including attorney fees and collection costs.", MARGIN + 4, y, bold, 8.5, RED); y -= 20

  // Dispute notice (italic).
  const coolingText = "You have the right to dispute this notice. If you believe this notice has been issued in error, please contact us in writing within 5 business days with supporting documentation."
  const coolingLines = wrapText(coolingText, italic, 9, CONTENT_WIDTH - 8)
  for (const line of coolingLines) { drawText(page, line, MARGIN + 4, y, italic, 9, GRAY); y -= 13 }
  y -= 14

  // ─── Contact block (the lender's collections contacts) ─────────────────
  const phones = [lender.collectionsPhone, lender.collectionsPhoneSecondary].filter(Boolean).join("    /    ")
  drawText(page, "Contact our collections department:", MARGIN + 4, y, bold, 9, DARK); y -= 14
  drawText(page, `Email:  ${lender.collectionsEmail}`, MARGIN + 14, y, regular, 9, DARK); y -= 13
  drawText(page, `Phone:  ${phones}`, MARGIN + 14, y, regular, 9, DARK); y -= 22

  // ─── Signature block ────────────────────────────────────────────────────
  drawText(page, "Authorised Signatory: _______________________________", MARGIN + 4, y, regular, 9, DARK)
  drawText(page, `Date: ${formatDatePdf(noticeDate)}`, MARGIN + 360, y, regular, 9, DARK); y -= 18
  drawText(page, "Collections Department", MARGIN + 4, y, bold, 9, DARK); y -= 12
  drawText(page, lender.legalName, MARGIN + 4, y, italic, 9, GRAY)

  // ─── Footer (compliance + address) ──────────────────────────────────────
  const footerY = MARGIN + 8
  page.drawLine({ start: { x: MARGIN, y: footerY + 32 }, end: { x: A4_WIDTH - MARGIN, y: footerY + 32 }, thickness: 0.5, color: GRAY })
  drawText(page, `${lender.legalName}  ·  ${lender.registeredOfficeLines.join(", ")}`, MARGIN, footerY + 18, regular, 7.5, GRAY)
  drawText(page, stripText, MARGIN, footerY + 6, regular, 7.5, GRAY)

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
