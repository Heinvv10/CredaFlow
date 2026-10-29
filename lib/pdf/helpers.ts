import { PDFDocument, PDFImage, PDFPage, PDFFont, rgb, RGB } from "pdf-lib"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { activeCurrency } from "@/lib/jurisdiction/active"
import { formatMoney } from "@/lib/jurisdiction/money"

export const A4_WIDTH = 595.28
export const A4_HEIGHT = 841.89
export const MARGIN = 40
/** Label/value split used by drawLabelValueTable. Exported so layout guards can
 *  measure the real value column instead of restating the offset. */
export const LABEL_VALUE_OFFSET = 220
export const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2

export const DARK: RGB = rgb(27 / 255, 29 / 255, 36 / 255)
export const ACCENT: RGB = rgb(67 / 255, 56 / 255, 202 / 255)
export const GRAY: RGB = rgb(100 / 255, 100 / 255, 100 / 255)
export const WHITE: RGB = rgb(1, 1, 1)
export const BLACK: RGB = rgb(0, 0, 0)

/** Embed the lender's letterhead logo (PNG bytes) into `doc`. Returns null
 *  (never throws) when there is no logo or it fails to embed — callers then
 *  draw the text-only header. The callers pass the tenant's uploaded logo
 *  (lib/config/lender-logo.ts) when it has one. */
export async function embedLogo(doc: PDFDocument, bytes: Uint8Array | undefined): Promise<PDFImage | null> {
  if (!bytes) return null
  try {
    return await doc.embedPng(bytes)
  } catch {
    return null
  }
}

/**
 * The size a logo prints at: `height` tall, unless that would make it wider
 * than `maxWidth`, when it is scaled down to that width with its shape kept.
 * A tenant's logo can be any shape the upload accepts; it must never print
 * over the letterhead's text or off the page.
 */
export function fitLogo(logo: { width: number; height: number }, height: number, maxWidth: number): { width: number; height: number } {
  const width = (logo.width / logo.height) * height
  return width <= maxWidth ? { width, height } : { width: maxWidth, height: height * (maxWidth / width) }
}

function roundedRectPath(width: number, height: number, radius: number): string {
  const r = radius
  return `M ${r},0 L ${width - r},0 A ${r},${r} 0 0 1 ${width},${r} L ${width},${height - r} A ${r},${r} 0 0 1 ${width - r},${height} L ${r},${height} A ${r},${r} 0 0 1 0,${height - r} L 0,${r} A ${r},${r} 0 0 1 ${r},0 Z`
}

/**
 * Draws the logo in a white rounded chip against a dark header bar that runs
 * from `barTop` down by `barHeight`. Anchored at `x` (left edge of the chip).
 * Returns the x-coordinate immediately to the right of the chip, where
 * following header text should start; the logo is scaled down so that text,
 * `trailingTextWidth` wide, still ends inside the right margin.
 */
export function drawLogoChip(
  page: PDFPage,
  logo: PDFImage,
  x: number,
  barTop: number,
  barHeight: number,
  trailingTextWidth: number,
): number {
  const chipHeight = barHeight - 16
  const chipPad = 10
  const gap = 16
  const { width: targetWidth, height: targetHeight } = fitLogo(
    logo, chipHeight - 12, A4_WIDTH - MARGIN - x - chipPad * 2 - gap - trailingTextWidth,
  )
  const chipWidth = targetWidth + chipPad * 2
  const chipY = barTop - barHeight + 8

  page.drawSvgPath(roundedRectPath(chipWidth, chipHeight, 8), {
    x,
    y: chipY + chipHeight,
    color: WHITE,
  })
  page.drawImage(logo, {
    x: x + chipPad,
    y: chipY + (chipHeight - targetHeight) / 2,
    width: targetWidth,
    height: targetHeight,
  })
  return x + chipWidth + gap
}

/**
 * Money on a statutory PDF. For ZAR this is the format the NCA documents have
 * always printed, byte for byte, negatives included ("R -0.05", "R -1,234.56",
 * and -0.4 cents as "R -0.00"): the rendered documents are pinned and each
 * client's legal team signs them off, so it is not changed. Another currency
 * (Lesotho) uses the house format, "-M 0.05".
 */
export function formatZarPdf(cents: number): string {
  const currency = activeCurrency()
  if (currency !== "ZAR") return formatMoney(cents, currency)
  return `R ${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`
}

export function formatDatePdf(date: Date): string {
  return date.toLocaleDateString("en-ZA", {
    timeZone: SAST_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

export function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color: RGB = DARK
): void {
  page.drawText(text, { x, y, size, font, color })
}

export function drawTableRow(
  page: PDFPage,
  y: number,
  cols: { text: string; x: number; width: number }[],
  font: PDFFont,
  fontSize: number,
  color: RGB = DARK,
  bgColor?: RGB
): void {
  if (bgColor) {
    page.drawRectangle({
      x: MARGIN,
      y: y - 4,
      width: CONTENT_WIDTH,
      height: 18,
      color: bgColor,
    })
  }
  for (const col of cols) {
    page.drawText(col.text, { x: col.x, y, size: fontSize, font, color })
  }
}

/** Draw a 2-column label/value table. Returns the Y after the table. */
export function drawLabelValueTable(
  page: PDFPage,
  startY: number,
  rows: [string, string][],
  labelFont: PDFFont,
  valueFont: PDFFont,
  fontSize: number = 9
): number {
  let y = startY
  const labelX = MARGIN + 4
  const valueX = MARGIN + LABEL_VALUE_OFFSET

  for (let i = 0; i < rows.length; i++) {
    const bg = i % 2 === 0 ? rgb(0.97, 0.96, 0.94) : WHITE
    page.drawRectangle({
      x: MARGIN,
      y: y - 4,
      width: CONTENT_WIDTH,
      height: 18,
      color: bg,
    })
    drawText(page, rows[i][0], labelX, y, labelFont, fontSize, GRAY)
    drawText(page, rows[i][1], valueX, y, valueFont, fontSize, DARK)
    y -= 18
  }
  return y
}

export function drawPageNumber(
  page: PDFPage,
  pageNum: number,
  totalPages: number,
  font: PDFFont,
  /**
   * Per-ceremony marker printed on EVERY page, left of the page number.
   *
   * Page substitution is what per-page initialling traditionally guards
   * against. Electronically the sha256 binding already beats initials — any
   * byte change breaks it. On the PRINTED path it does not: the returned scan
   * is a different document, and POST /signing-packet only checks page COUNT,
   * so a swapped page passes. This binds every page to one ceremony instead,
   * checkable by eye and by OCR.
   *
   * It cannot be the document's own digest — printing a hash into the document
   * changes the document, and therefore the hash. It is a prefix of
   * pasqEvidenceSha256, which is computed BEFORE either PDF is rendered and is
   * identical across both documents in a packet.
   */
  ceremonyMarker?: string,
): void {
  const text = `Page ${pageNum} of ${totalPages}`
  const textWidth = font.widthOfTextAtSize(text, 8)
  drawText(page, text, A4_WIDTH - MARGIN - textWidth, 20, font, 8, GRAY)
  if (ceremonyMarker) {
    drawText(page, `Ref ${ceremonyMarker}`, MARGIN, 20, font, 8, GRAY)
  }
}

export function drawSectionTitle(
  page: PDFPage,
  y: number,
  title: string,
  font: PDFFont
): number {
  page.drawRectangle({
    x: MARGIN,
    y: y - 6,
    width: CONTENT_WIDTH,
    height: 22,
    color: ACCENT,
  })
  drawText(page, title, MARGIN + 6, y, font, 11, WHITE)
  return y - 30
}

/**
 * Draws table rows top-down. A row that would start below `floor` goes onto a
 * continuation page from `openContinuation` (which adds the page and repeats
 * the table's own title and column headers) — a table never stops short of
 * its last row. `drawRow` draws one row, or one unit that must stay together,
 * and returns the y below it. Returns where the last row left off, which is
 * where anything that follows the table (its TOTAL, its footer) belongs.
 */
export function drawRowsWithContinuation<T>(table: {
  page: PDFPage
  y: number
  rows: readonly T[]
  floor: number
  openContinuation: (from: PDFPage) => { page: PDFPage; y: number }
  drawRow: (page: PDFPage, y: number, row: T, index: number) => number
}): { page: PDFPage; y: number } {
  let { page, y } = table
  for (let i = 0; i < table.rows.length; i++) {
    if (y < table.floor) ({ page, y } = table.openContinuation(page))
    y = table.drawRow(page, y, table.rows[i], i)
  }
  return { page, y }
}
