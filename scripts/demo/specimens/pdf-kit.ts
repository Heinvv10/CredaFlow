/**
 * Shared drawing helpers for the specimen PDFs.
 *
 * Text is drawn as real PDF text (Helvetica), never rasterised, so the
 * documents carry a text layer as a digitally-issued payslip or statement does.
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib'
import sharp from 'sharp'

export const A4: readonly [number, number] = [595.28, 841.89]
export const MARGIN = 40

export interface Fonts {
  regular: PDFFont
  bold: PDFFont
}

export async function newDocument(title: string): Promise<{ doc: PDFDocument; fonts: Fonts }> {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  doc.setAuthor('CredaFlow demo simulator')
  doc.setSubject('SPECIMEN — fictional person, not a valid document')
  doc.setProducer('CredaFlow demo simulator')
  doc.setCreator('CredaFlow demo simulator')
  // Fixed dates keep the bytes (and so the SHA-256 in the manifest) stable.
  const epoch = new Date('2026-01-01T00:00:00Z')
  doc.setCreationDate(epoch)
  doc.setModificationDate(epoch)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  return { doc, fonts: { regular, bold } }
}

/** 2337480 → "23 374.80" (SA thousands spacing). */
export function money(cents: number): string {
  const negative = cents < 0
  const abs = Math.abs(Math.round(cents))
  const rands = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${negative ? '-' : ''}${rands}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * The diagonal SPECIMEN mark, as a transparent PNG covering an A4 page.
 *
 * An IMAGE rather than PDF text on purpose: as text, its letters land in the
 * page's text layer and interleave with the real figures in any text
 * extraction ("S P E C I M E N" scattered between payslip rows).
 */
let watermarkPng: Promise<Buffer> | null = null
function watermarkImage(): Promise<Buffer> {
  watermarkPng ??= sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1191" height="1684">
      <text x="595" y="900" text-anchor="middle" transform="rotate(-35 595 842)"
        style="font-family:'DejaVu Sans',sans-serif;font-weight:bold;font-size:230px;fill:#d93333;fill-opacity:0.1">SPECIMEN</text>
    </svg>`,
  )).png().toBuffer()
  return watermarkPng
}

/**
 * Drawn BEFORE the page content so every figure sits on top of it — a mark
 * across the digits is what makes a model misread them.
 */
export async function drawWatermark(doc: PDFDocument, page: PDFPage): Promise<void> {
  const image = await doc.embedPng(await watermarkImage())
  const { width, height } = page.getSize()
  page.drawImage(image, { x: 0, y: 0, width, height })
}

export function drawFooter(page: PDFPage, fonts: Fonts, note: string): void {
  page.drawText(note, { x: MARGIN, y: 22, size: 7, font: fonts.regular, color: rgb(0.45, 0.45, 0.45) })
}

export interface TextOpts {
  size?: number
  bold?: boolean
  color?: [number, number, number]
}

export function text(page: PDFPage, fonts: Fonts, value: string, x: number, y: number, opts: TextOpts = {}): void {
  const [r, g, b] = opts.color ?? [0.1, 0.1, 0.1]
  page.drawText(value, { x, y, size: opts.size ?? 9, font: opts.bold ? fonts.bold : fonts.regular, color: rgb(r, g, b) })
}

/** Right-aligned at `right`. */
export function textRight(page: PDFPage, fonts: Fonts, value: string, right: number, y: number, opts: TextOpts = {}): void {
  const font = opts.bold ? fonts.bold : fonts.regular
  text(page, fonts, value, right - font.widthOfTextAtSize(value, opts.size ?? 9), y, opts)
}

export function rule(page: PDFPage, y: number, x1 = MARGIN, x2 = A4[0] - MARGIN, thickness = 0.6): void {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color: rgb(0.55, 0.55, 0.55) })
}

export function shade(page: PDFPage, x: number, y: number, width: number, height: number, grey = 0.93): void {
  page.drawRectangle({ x, y, width, height, color: rgb(grey, grey, grey) })
}

export const SPECIMEN_FOOTER =
  'SPECIMEN — generated for software demonstration. Fictional person and employer; not a valid document.'
