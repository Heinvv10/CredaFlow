/**
 * Renders a CheatSheet onto ONE A4 page. The body font shrinks in small steps
 * until everything fits; below MIN_SIZE the sheet is too long to be readable
 * at a glance and rendering fails rather than spilling onto a second page.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { A4 } from '../specimens/pdf-kit'
import type { CheatSheet } from './cheat-sheet'

const MARGIN = 30
const MAX_SIZE = 9
const MIN_SIZE = 6
const WIDTH = A4[0] - 2 * MARGIN

interface Fonts { regular: PDFFont; bold: PDFFont; italic: PDFFont }

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Walks the sheet at `size`; draws when `page` is given. Returns the height used. */
function layout(sheet: CheatSheet, fonts: Fonts, size: number, page?: PDFPage): number {
  const lead = size * 1.25
  let y = A4[1] - MARGIN
  const put = (value: string, x: number, font: PDFFont, s: number, grey = 0.1): void => {
    page?.drawText(value, { x, y: y - s, size: s, font, color: rgb(grey, grey, grey) })
  }
  const para = (value: string, x: number, width: number, font: PDFFont, grey = 0.1): void => {
    for (const line of wrap(value, font, size, width)) {
      put(line, x, font, size, grey)
      y -= lead
    }
  }

  put(sheet.title, MARGIN, fonts.bold, size + 4)
  y -= (size + 4) * 1.3
  para(sheet.subtitle, MARGIN, WIDTH, fonts.italic, 0.3)
  for (const s of sheet.sections) {
    y -= size * 0.6
    put(s.heading.toUpperCase(), MARGIN, fonts.bold, size + 0.5, 0.25)
    y -= (size + 0.5) * 1.35
    const labelWidth = 118
    for (const [label, value] of s.rows ?? []) {
      if (fonts.bold.widthOfTextAtSize(label, size) > labelWidth - 4) throw new Error(`label "${label}" is wider than its column`)
      put(label, MARGIN, fonts.bold, size)
      para(value, MARGIN + labelWidth, WIDTH - labelWidth, fonts.regular)
    }
    ;(s.items ?? []).forEach((item, i) => {
      put(s.numbered ? `${i + 1}.` : '-', MARGIN, fonts.bold, size)
      para(item, MARGIN + 14, WIDTH - 14, fonts.regular)
    })
    if (s.quote) para(`"${s.quote}"`, MARGIN + 8, WIDTH - 8, fonts.italic)
  }
  y -= size * 0.6
  para('Presenter notes. SPECIMEN persona; the ID card carries the presenter\'s real photo: do not share.', MARGIN, WIDTH, fonts.italic, 0.45)
  return A4[1] - MARGIN - y
}

export async function renderCheatSheetPdf(sheet: CheatSheet): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Cheat sheet: ${sheet.title}`)
  doc.setAuthor('CredaFlow demo simulator')
  doc.setSubject('Live-demo presenter cheat sheet (SPECIMEN persona)')
  const epoch = new Date('2026-01-01T00:00:00Z')
  doc.setCreationDate(epoch)
  doc.setModificationDate(epoch)
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }
  const available = A4[1] - 2 * MARGIN
  let size = MAX_SIZE
  while (layout(sheet, fonts, size) > available) {
    size -= 0.25
    if (size < MIN_SIZE) throw new Error(`cheat sheet "${sheet.title}" does not fit one page at ${MIN_SIZE}pt`)
  }
  layout(sheet, fonts, size, doc.addPage([A4[0], A4[1]]))
  return doc.save({ useObjectStreams: false })
}
