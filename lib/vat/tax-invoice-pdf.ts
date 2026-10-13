// Renders an issued TaxInvoice (with its lines) as a PDF. Everything printed
// comes from the stored row, never from current configuration, so a re-render
// of the same invoice is byte-identical (the PDF dates are the row's
// createdAt). Content follows VAT Act s20(4); see ./tax-invoice.ts.
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib"
import type { Prisma } from "@prisma/client"
import {
  A4_WIDTH, A4_HEIGHT, MARGIN, CONTENT_WIDTH,
  DARK, ACCENT, GRAY, WHITE,
  formatZarPdf, formatDatePdf,
  drawText, drawTableRow, drawPageNumber, drawSectionTitle, drawRowsWithContinuation,
  embedLogo, drawLogoChip,
} from "@/lib/pdf/helpers"

export interface TaxInvoicePdfLine {
  lineNo: number
  description: string
  quantity: number
  unitExclVatCents: number
  exclVatCents: number
  vatCents: number
  inclVatCents: number
}

export interface TaxInvoicePdfInput {
  invoiceNumber: string
  issueDate: Date
  supplyDate: Date
  createdAt: Date
  supplierName: string
  supplierAddress: string
  supplierVatNumber: string
  recipientName: string
  recipientAddress: string
  recipientVatNumber: string | null
  vatRate: Prisma.Decimal | string
  totalExclVatCents: number
  vatCents: number
  totalInclVatCents: number
  lines: readonly TaxInvoicePdfLine[]
}

const BODY = 9
const LINE_GAP = 12
const FLOOR = 90
// Numeric columns are right-aligned and wide enough for R 21,474,836.47 (the
// largest INTEGER cents value) at 9 pt.
const COLUMNS = {
  description: { x: MARGIN + 4, width: 165 },
  quantity: { x: MARGIN + 172, width: 25 },
  unit: { x: MARGIN + 200, width: 75 },
  excl: { x: MARGIN + 280, width: 75 },
  vat: { x: MARGIN + 360, width: 70 },
  incl: { x: MARGIN + 435, width: 76 },
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let current = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current)
        current = word
      } else current = candidate
    }
    if (current) lines.push(current)
  }
  return lines
}

/** Right-aligns `text` in a column. */
function right(page: PDFPage, text: string, column: { x: number; width: number }, y: number, font: PDFFont): void {
  drawText(page, text, column.x + column.width - font.widthOfTextAtSize(text, BODY), y, font, BODY, DARK)
}

function ratePercent(rate: Prisma.Decimal | string): string {
  const percent = Number(rate.toString()) * 100
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2)}%`
}

export async function generateTaxInvoicePdf(invoice: TaxInvoicePdfInput, opts: { logo?: Uint8Array } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Tax Invoice ${invoice.invoiceNumber}`)
  doc.setCreationDate(invoice.createdAt)
  doc.setModificationDate(invoice.createdAt)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const first = doc.addPage([A4_WIDTH, A4_HEIGHT])
  const barHeight = 70
  const vatLine = `VAT Reg No: ${invoice.supplierVatNumber}`
  first.drawRectangle({ x: 0, y: A4_HEIGHT - barHeight, width: A4_WIDTH, height: barHeight, color: DARK })
  const logo = await embedLogo(doc, opts.logo)
  if (logo) {
    const textX = drawLogoChip(first, logo, MARGIN, A4_HEIGHT, barHeight, regular.widthOfTextAtSize(vatLine, 9))
    drawText(first, vatLine, textX, A4_HEIGHT - 36, regular, 9, WHITE)
  } else {
    drawText(first, invoice.supplierName, MARGIN, A4_HEIGHT - 36, bold, 16, WHITE)
    drawText(first, vatLine, MARGIN, A4_HEIGHT - 54, regular, 9, WHITE)
  }

  let y = A4_HEIGHT - 100
  drawText(first, "TAX INVOICE", MARGIN, y, bold, 18, ACCENT)
  const meta: [string, string][] = [
    ["Invoice No:", invoice.invoiceNumber],
    ["Date of issue:", formatDatePdf(invoice.issueDate)],
    ["Date of supply:", formatDatePdf(invoice.supplyDate)],
  ]
  meta.forEach(([label, value], i) => {
    drawText(first, label, A4_WIDTH - MARGIN - 200, y - i * 14, bold, BODY, DARK)
    drawText(first, value, A4_WIDTH - MARGIN - 110, y - i * 14, regular, BODY, DARK)
  })
  y -= 3 * 14 + 16

  const party = (title: string, rows: [string, string][]): void => {
    y = drawSectionTitle(first, y, title, bold)
    for (const [label, value] of rows) {
      drawText(first, label, MARGIN + 4, y, bold, BODY, DARK)
      for (const line of wrap(value, regular, BODY, CONTENT_WIDTH - 130)) {
        drawText(first, line, MARGIN + 120, y, regular, BODY, DARK)
        y -= LINE_GAP
      }
      y -= 2
    }
    y -= 6
  }
  party("SUPPLIER", [
    ["Name:", invoice.supplierName],
    ["Address:", invoice.supplierAddress],
    ["VAT Reg No:", invoice.supplierVatNumber],
  ])
  party("RECIPIENT", [
    ["Name:", invoice.recipientName],
    ["Address:", invoice.recipientAddress],
    ...(invoice.recipientVatNumber ? [["VAT Reg No:", invoice.recipientVatNumber] as [string, string]] : []),
  ])

  const drawHeaders = (page: PDFPage, top: number): number => {
    const headers: [keyof typeof COLUMNS, string][] = [
      ["description", "Description"], ["quantity", "Qty"], ["unit", "Unit excl. VAT"],
      ["excl", "Value excl. VAT"], ["vat", "VAT"], ["incl", "Total incl. VAT"],
    ]
    drawTableRow(page, top, headers.map(([key, text]) => {
      const column = COLUMNS[key]
      const x = key === "description" ? column.x : column.x + column.width - bold.widthOfTextAtSize(text, 8)
      return { text, x, width: column.width }
    }), bold, 8, GRAY)
    return top - 18
  }
  y = drawSectionTitle(first, y, "GOODS AND SERVICES SUPPLIED", bold)
  y = drawHeaders(first, y)

  const end = drawRowsWithContinuation({
    page: first,
    y,
    rows: invoice.lines,
    floor: FLOOR,
    openContinuation: () => {
      const page = doc.addPage([A4_WIDTH, A4_HEIGHT])
      const top = drawSectionTitle(page, A4_HEIGHT - MARGIN - 20, "GOODS AND SERVICES SUPPLIED", bold)
      return { page, y: drawHeaders(page, top) }
    },
    drawRow: (page, rowY, line) => {
      right(page, String(line.quantity), COLUMNS.quantity, rowY, regular)
      right(page, formatZarPdf(line.unitExclVatCents), COLUMNS.unit, rowY, regular)
      right(page, formatZarPdf(line.exclVatCents), COLUMNS.excl, rowY, regular)
      right(page, formatZarPdf(line.vatCents), COLUMNS.vat, rowY, regular)
      right(page, formatZarPdf(line.inclVatCents), COLUMNS.incl, rowY, regular)
      let lineY = rowY
      for (const text of wrap(line.description, regular, BODY, COLUMNS.description.width)) {
        drawText(page, text, COLUMNS.description.x, lineY, regular, BODY, DARK)
        lineY -= LINE_GAP
      }
      return lineY - 6
    },
  })

  let { page } = end
  y = end.y
  if (y - 3 * 16 < FLOOR - 40) {
    page = doc.addPage([A4_WIDTH, A4_HEIGHT])
    y = A4_HEIGHT - MARGIN - 20
  }
  page.drawLine({ start: { x: MARGIN, y: y + 8 }, end: { x: MARGIN + CONTENT_WIDTH, y: y + 8 }, thickness: 0.5, color: GRAY })
  const totals: [string, number][] = [
    ["Value of supply (excl. VAT)", invoice.totalExclVatCents],
    [`VAT charged at ${ratePercent(invoice.vatRate)}`, invoice.vatCents],
    ["Total consideration (incl. VAT)", invoice.totalInclVatCents],
  ]
  for (const [label, cents] of totals) {
    drawText(page, label, COLUMNS.unit.x, y - 6, bold, BODY, DARK)
    right(page, formatZarPdf(cents), COLUMNS.incl, y - 6, bold)
    y -= 16
  }

  const pages = doc.getPages()
  pages.forEach((p, i) => drawPageNumber(p, i + 1, pages.length, regular))
  return Buffer.from(await doc.save())
}
