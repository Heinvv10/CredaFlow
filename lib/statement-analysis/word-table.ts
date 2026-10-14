/**
 * Helpers for the readers that read rows from word boxes (`pdftotext -bbox`):
 * statements set in a proportional font, whose `-layout` columns drift. Each
 * bank's money columns are right-aligned a few points from their header word,
 * so a figure belongs to the column whose right edge is nearest.
 */
import type { PdfWord } from "./pdf-tools"

/** Words grouped into printed lines, top to bottom, each left to right. */
export function wordLines(words: PdfWord[]): PdfWord[][] {
  const sorted = [...words].sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin)
  const out: PdfWord[][] = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0].yMin - w.yMin) <= 2) last.push(w)
    else out.push([w])
  }
  return out.map((l) => l.sort((a, b) => a.xMin - b.xMin))
}

export interface Figure {
  text: string
  xMax: number
}

/** Words closer than this (pt) belong to one printed figure ("R" "1" "234.56"). */
const FIGURE_GAP_PT = 4
/**
 * A statement line holds a few dozen words. A longer one is not statement text,
 * and is skipped like an over-long `-layout` line (layout.ts MAX_LINE_CHARS).
 */
const MAX_LINE_WORDS = 200
/** The most words one figure prints as ("-R" "1" "234" "567.89"), and the longest one of them. */
const MAX_FIGURE_WORDS = 5
const MAX_FIGURE_WORD_CHARS = 16

/**
 * Splits a line into the figures `isFigure` accepts and the remaining words.
 * A figure may be printed as several words ("R 1,234.56", "1 234,56-"): from
 * each word that ends like an amount, it takes the longest run of adjacent
 * words to its left that still reads as one figure.
 */
export function splitFigures(line: PdfWord[], isFigure: (text: string) => boolean): { figures: Figure[]; words: PdfWord[] } {
  if (line.length > MAX_LINE_WORDS) return { figures: [], words: [] }
  const used = new Set<number>()
  const figures: Figure[] = []
  for (let end = line.length - 1; end >= 0; end--) {
    if (used.has(end) || line[end].text.length > MAX_FIGURE_WORD_CHARS || !/\d[.,]\d{2}-?$/.test(line[end].text)) continue
    let best = -1
    let text = line[end].text
    if (isFigure(text)) best = end
    const first = Math.max(0, end - MAX_FIGURE_WORDS + 1)
    for (let start = end - 1; start >= first && !used.has(start) && line[start].text.length <= MAX_FIGURE_WORD_CHARS
      && line[start + 1].xMin - line[start].xMax < FIGURE_GAP_PT; start--) {
      text = `${line[start].text} ${text}`
      if (isFigure(text)) best = start
    }
    if (best < 0) continue
    for (let i = best; i <= end; i++) used.add(i)
    figures.unshift({ text: line.slice(best, end + 1).map((w) => w.text).join(" "), xMax: line[end].xMax })
  }
  return { figures, words: line.filter((_, i) => !used.has(i)) }
}

/** How far (pt) a figure's right edge may sit from its column's. */
const COLUMN_SLACK_PT = 30

/** The column whose right edge is nearest `x`, within COLUMN_SLACK_PT. */
export function nearestColumn<K extends string>(x: number, cols: Record<K, number>): K | null {
  let best: K | null = null
  for (const c of Object.keys(cols) as K[]) {
    const d = Math.abs(x - cols[c])
    if (d <= COLUMN_SLACK_PT && (best === null || d < Math.abs(x - cols[best]))) best = c
  }
  return best
}

/** The right edge of a header label: the label word, or the "(R)"/"R" printed just after it. */
export function labelEdge(line: PdfWord[], label: RegExp): number | null {
  const i = line.findIndex((w) => label.test(w.text))
  if (i < 0) return null
  const unit = line[i + 1]
  return unit && /^\(?R\)?$/.test(unit.text) && unit.xMin - line[i].xMax < 8 ? unit.xMax : line[i].xMax
}

export const lineText = (line: PdfWord[]) => line.map((w) => w.text).join(" ")
