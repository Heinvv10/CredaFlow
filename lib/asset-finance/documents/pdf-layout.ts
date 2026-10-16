// Page layout shared by the asset-finance deal documents (agreement,
// suretyship, resolution). Built on the lib/pdf helpers by import; nothing in
// lib/pdf changes, so the consumer NCA documents keep their pinned bytes.
//
// Output is deterministic: the PDF dates are the caller's document date, the
// fonts are the standard fonts, and nothing random or clock-based is drawn.
// Every string passes winAnsiSafe, so a name the standard fonts cannot encode
// prints a substitute instead of failing the render.
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import {
  A4_HEIGHT, A4_WIDTH, CONTENT_WIDTH, DARK, GRAY, MARGIN, WHITE,
  drawPageNumber, drawRowsWithContinuation, drawSectionTitle, drawText, formatDatePdf,
} from "@/lib/pdf/helpers"
import { winAnsiSafe } from "@/lib/pdf/executed-agreement"

/** Marks every clause whose wording the lender's legal team has not supplied. */
export const PLACEHOLDER_CLAUSE = "[Placeholder clause — wording to be supplied by the lender's legal team]"
/** Printed diagonally across every page until TenantConfig.assetFinanceLegalWordingApproved. */
export const DRAFT_WATERMARK = "DRAFT — NOT FOR EXECUTION"

const BODY = 9
const LINE = 12
const FLOOR = 70
const TOP = A4_HEIGHT - MARGIN - 10
const WATERMARK_COLOUR = rgb(0.78, 0.12, 0.12)

export interface TableColumn {
  header: string
  x: number
  width: number
  align?: "left" | "right"
}

export interface SignatureLine {
  caption: string
  name: string
  detail?: string
}

export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  // Split before sanitising: winAnsiSafe turns a newline into "?".
  for (const paragraph of text.split(/\r?\n/)) {
    let current = ""
    for (const word of winAnsiSafe(paragraph).split(/\s+/).filter(Boolean)) {
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

export class DealDocumentWriter {
  page: PDFPage
  y: number

  private constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly italic: PDFFont,
  ) {
    this.page = doc.addPage([A4_WIDTH, A4_HEIGHT])
    this.y = TOP
  }

  static async create(meta: { title: string; documentDate: Date }): Promise<DealDocumentWriter> {
    const doc = await PDFDocument.create()
    doc.setTitle(winAnsiSafe(meta.title))
    doc.setCreationDate(meta.documentDate)
    doc.setModificationDate(meta.documentDate)
    const [regular, bold, italic] = await Promise.all([
      doc.embedFont(StandardFonts.Helvetica),
      doc.embedFont(StandardFonts.HelveticaBold),
      doc.embedFont(StandardFonts.HelveticaOblique),
    ])
    return new DealDocumentWriter(doc, regular, bold, italic)
  }

  newPage(): void {
    this.page = this.doc.addPage([A4_WIDTH, A4_HEIGHT])
    this.y = TOP
  }

  /** Start a new page unless `height` points still fit above the footer. */
  ensure(height: number): void {
    if (this.y - height < FLOOR) this.newPage()
  }

  gap(points: number): void {
    this.y -= points
  }

  /** The lender letterhead: a dark bar with the legal name and its registrations. */
  letterhead(lenderName: string, lines: readonly string[]): void {
    const barHeight = 56 + Math.max(0, lines.length - 2) * 11
    this.page.drawRectangle({ x: 0, y: A4_HEIGHT - barHeight, width: A4_WIDTH, height: barHeight, color: DARK })
    drawText(this.page, winAnsiSafe(lenderName), MARGIN, A4_HEIGHT - 26, this.bold, 14, WHITE)
    lines.forEach((line, i) => drawText(this.page, winAnsiSafe(line), MARGIN, A4_HEIGHT - 42 - i * 11, this.regular, 8, WHITE))
    this.y = A4_HEIGHT - barHeight - 28
  }

  title(text: string, subtitle: readonly string[]): void {
    drawText(this.page, winAnsiSafe(text), MARGIN, this.y, this.bold, 16, DARK)
    this.y -= 18
    for (const line of subtitle) {
      drawText(this.page, winAnsiSafe(line), MARGIN, this.y, this.regular, BODY, GRAY)
      this.y -= LINE
    }
    this.y -= 10
  }

  section(text: string): void {
    this.ensure(72)
    // The bar reaches 16 points above its baseline: clear the line above it.
    if (this.y < TOP) this.y -= 12
    this.y = drawSectionTitle(this.page, this.y, winAnsiSafe(text), this.bold)
  }

  paragraph(text: string, font: PDFFont = this.regular, indent = 0): void {
    for (const line of wrapText(text, font, BODY, CONTENT_WIDTH - indent)) {
      this.ensure(LINE)
      drawText(this.page, line, MARGIN + indent, this.y, font, BODY, DARK)
      this.y -= LINE
    }
    this.y -= 4
  }

  /** A numbered clause whose wording is a placeholder, marked as such. */
  placeholderClause(number: string, heading: string): void {
    this.ensure(3 * LINE)
    drawText(this.page, winAnsiSafe(`${number} ${heading}`), MARGIN, this.y, this.bold, BODY, DARK)
    this.y -= LINE
    this.paragraph(PLACEHOLDER_CLAUSE, this.italic, 14)
  }

  /** Label/value rows; long values wrap under their value column. */
  labelValues(rows: readonly [string, string][]): void {
    const valueX = MARGIN + 170
    for (const [label, value] of rows) {
      const lines = wrapText(value, this.regular, BODY, CONTENT_WIDTH - 170)
      this.ensure(Math.max(1, lines.length) * LINE)
      drawText(this.page, winAnsiSafe(label), MARGIN + 4, this.y, this.bold, BODY, GRAY)
      for (const line of lines.length > 0 ? lines : ["—"]) {
        drawText(this.page, line, valueX, this.y, this.regular, BODY, DARK)
        this.y -= LINE
      }
      this.y -= 2
    }
    this.y -= 6
  }

  /** A table that continues onto new pages, repeating its title and headers. */
  table(title: string, columns: readonly TableColumn[], rows: readonly string[][]): void {
    const cell = (page: PDFPage, y: number, text: string, column: TableColumn, font: PDFFont, size: number) => {
      const safe = winAnsiSafe(text)
      const x = column.align === "right" ? column.x + column.width - font.widthOfTextAtSize(safe, size) : column.x
      drawText(page, safe, x, y, font, size, DARK)
    }
    const headers = (page: PDFPage, top: number) => {
      columns.forEach((c) => cell(page, top, c.header, c, this.bold, 8))
      return top - 14
    }
    this.section(title)
    const end = drawRowsWithContinuation({
      page: this.page,
      y: headers(this.page, this.y),
      rows,
      floor: FLOOR,
      openContinuation: () => {
        this.newPage()
        const top = drawSectionTitle(this.page, this.y, winAnsiSafe(`${title} (continued)`), this.bold)
        return { page: this.page, y: headers(this.page, top) }
      },
      drawRow: (page, y, row) => {
        row.forEach((text, i) => cell(page, y, text, columns[i], this.regular, 8))
        return y - 12
      },
    })
    this.page = end.page
    this.y = end.y - 8
  }

  /** Signature rules: a line to sign on, the signer's name and capacity, and a date line. */
  signatures(lines: readonly SignatureLine[]): void {
    for (const line of lines) {
      this.ensure(70)
      drawText(this.page, winAnsiSafe(line.caption), MARGIN, this.y, this.bold, BODY, DARK)
      this.y -= 34
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + 240, y: this.y }, thickness: 0.6, color: DARK })
      this.page.drawLine({ start: { x: MARGIN + 300, y: this.y }, end: { x: MARGIN + 420, y: this.y }, thickness: 0.6, color: DARK })
      this.y -= 11
      drawText(this.page, winAnsiSafe(line.name), MARGIN, this.y, this.regular, 8, DARK)
      drawText(this.page, "Date", MARGIN + 300, this.y, this.regular, 8, GRAY)
      if (line.detail) {
        this.y -= 10
        drawText(this.page, winAnsiSafe(line.detail), MARGIN, this.y, this.regular, 8, GRAY)
      }
      this.y -= 18
    }
  }

  /** Page numbers, the reference on every page, the DRAFT watermark unless approved; the bytes. */
  async finish(opts: { reference: string; watermark: boolean }): Promise<Buffer> {
    const pages = this.doc.getPages()
    pages.forEach((page, i) => {
      drawPageNumber(page, i + 1, pages.length, this.regular, winAnsiSafe(opts.reference))
      if (opts.watermark) drawWatermark(page, this.bold)
    })
    return Buffer.from(await this.doc.save())
  }
}

/** Large, diagonal, semi-transparent, centred on the page. */
function drawWatermark(page: PDFPage, font: PDFFont): void {
  const size = 52
  const width = font.widthOfTextAtSize(DRAFT_WATERMARK, size)
  const height = font.heightAtSize(size, { descender: false })
  const angle = Math.atan2(A4_HEIGHT, A4_WIDTH)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  page.drawText(DRAFT_WATERMARK, {
    x: A4_WIDTH / 2 - (width / 2) * cos + (height / 2) * sin,
    y: A4_HEIGHT / 2 - (width / 2) * sin - (height / 2) * cos,
    size,
    font,
    color: WATERMARK_COLOUR,
    opacity: 0.2,
    rotate: degrees((angle * 180) / Math.PI),
  })
}

/** "13 October 2026" from an ISO calendar date, the same format as formatDatePdf. */
export function formatIsoDatePdf(iso: string): string {
  return formatDatePdf(new Date(`${iso}T12:00:00.000Z`))
}
