/**
 * FNB statement text reader.
 *
 * Layout (learned from masked corpus shapes, see .claude.md): page 1 prints
 * "Statement Period : 1 May 2026 to 31 May 2026" and a "Statement Balances"
 * block with "Opening Balance  9,999.99 Cr" and "Closing Balance". Rows are
 * "dd Mon  Description ...  Amount  Balance  [Accrued Bank Charges]" with no
 * year. FNB marks only credits: an amount or balance with "Cr" is money in /
 * in credit, and one without it is a debit / overdrawn (some print "Dr").
 * Accrued charges are only levied later as their own row, so they never move
 * the running balance.
 *
 * Rows are read from word boxes, not `-layout` text: FNB sets the table in a
 * proportional font, so character columns drift from row to row, while the
 * money columns are right-aligned to a fixed x a few points right of their
 * header word. Each figure goes to the column whose right edge is nearest.
 */
import { parseRandToCents } from "./money"
import { holderFromTitleLine, isoFromDayMonthYear, last4, lineMatch, MONTHS, validIso } from "./layout"
import type { PdfWord } from "./pdf-tools"
import type { StatementRead, StatementTransaction } from "./types"
import { nearestColumn, wordLines } from "./word-table"

const AMOUNT_WORD = /^\d{1,3}(?:,\d{3})*\.\d{2}(Cr|Dr)?$/
const DAY = /^\d{2}$/
const MON = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/
/**
 * A row FNB prints without posting it ("EDO Collection Attempt" and kin): see
 * StatementTransaction.nonPosting. The word alone is not enough — a client can
 * put it in their own payment reference — so the row must also leave the
 * printed balance where it was (markNonPosting).
 */
const NON_POSTING = /\bAttempt\b/i
const PERIOD = /Statement Period[ \t]*:[ \t]*(\d{1,2} [A-Za-z]+ \d{4})[ \t]+to[ \t]+(\d{1,2} [A-Za-z]+ \d{4})/

type Column = "amount" | "balance" | "charges"
type Columns = Record<Column, number>

function columnsOf(line: PdfWord[], below: PdfWord[] | undefined, above: PdfWord[] | undefined): Columns | null {
  const at = (ws: PdfWord[] | undefined, t: string) => ws?.find((w) => w.text === t)
  const amount = at(line, "Amount")
  const balance = at(line, "Balance")
  // The header starts with "Date": a reference that happens to say "Date Amount Balance" must not move the columns.
  if (line[0]?.text !== "Date" || !amount || !balance) return null
  const charges = at(below, "Charges") ?? at(above, "Accrued") ?? at(line, "Bank")
  return { amount: amount.xMax, balance: balance.xMax, charges: charges?.xMax ?? balance.xMax + 50 }
}

/** Signed cents in FNB's convention: Cr is positive, anything else negative. */
function fnbCents(text: string): number | null {
  const v = parseRandToCents(text.replace(/\s?(Cr|Dr)$/, ""))
  if (v === null) return null
  return /Cr$/.test(text) || v === 0 ? v : -v
}

function headerBalance(text: string, label: string): number | null {
  const m = lineMatch(text, new RegExp(`${label}[ \\t]+(\\d{1,3}(?:,\\d{3})*\\.\\d{2}(?: ?(?:Cr|Dr))?)`))
  return m ? fnbCents(m[1]) : null
}

/** Year for a dd Mon row: the period's start year, +1 once the months wrap. */
function rowDate(day: string, mon: string, start: string | null): string | null {
  if (!start) return null
  const mo = MONTHS.indexOf(mon.toLowerCase()) + 1
  const startYear = Number(start.slice(0, 4))
  return validIso(mo < Number(start.slice(5, 7)) ? startYear + 1 : startYear, mo, Number(day))
}

function readRow(line: PdfWord[], cols: Columns, periodStart: string | null, page: number): StatementTransaction | null {
  if (line.length < 3 || !DAY.test(line[0].text) || !MON.test(line[1].text)) return null
  const figures: Partial<Record<Column, string>> = {}
  const description: string[] = []
  for (let i = 2; i < line.length; i++) {
    const w = line[i]
    const next = line[i + 1]
    const col = AMOUNT_WORD.test(w.text) ? nearestColumn(w.xMax, cols) : null
    if (!col) {
      description.push(w.text)
      continue
    }
    const suffix = next && /^(Cr|Dr)$/.test(next.text) && next.xMin - w.xMax < 4 ? next.text : ""
    if (suffix) i++
    if (figures[col]) return null
    figures[col] = `${w.text}${suffix}`
  }
  // FNB prints a balance on every row (corpus: no row without one): one without is
  // a misread or an edit, and a blank balance lets a +X/−X pair of edits cancel out.
  if (!figures.amount || !figures.balance) return null
  const amountCents = fnbCents(figures.amount)
  const date = rowDate(line[0].text, line[1].text, periodStart)
  if (amountCents === null || !date) return null
  const text = description.join(" ")
  return {
    date,
    description: text,
    amountCents,
    balanceCents: fnbCents(figures.balance),
    page,
  }
}

function readRows(words: PdfWord[][], periodStart: string | null): StatementTransaction[] {
  const rows: StatementTransaction[] = []
  let cols: Columns | null = null
  words.forEach((pageWords, p) => {
    const ls = wordLines(pageWords)
    ls.forEach((line, i) => {
      cols = columnsOf(line, ls[i + 1], ls[i - 1]) ?? cols
      if (!cols) return
      const row = readRow(line, cols, periodStart, p + 1)
      if (row) rows.push(row)
    })
  })
  return rows
}

/** Flags attempt rows whose printed balance equals the balance before them. */
function markNonPosting(rows: StatementTransaction[], opening: number | null): StatementTransaction[] {
  let before = opening
  return rows.map((t) => {
    const unmoved = t.balanceCents !== null && before !== null && t.balanceCents === before && t.amountCents !== 0
    if (t.balanceCents !== null) before = t.balanceCents
    return NON_POSTING.test(t.description) && unmoved ? { ...t, nonPosting: true as const } : t
  })
}

/** Reads an FNB statement's text layer, or null when it is not one. */
export function readFnb(pages: string[], words: PdfWord[][]): StatementRead | null {
  const all = pages.join("\n")
  const period = lineMatch(all, PERIOD)
  if (!period || !/Opening Balance/.test(all)) return null
  const periodStart = isoFromDayMonthYear(period[1])
  return {
    accountHolderName: holderFromTitleLine(pages[0] ?? ""),
    accountNumberLast4: last4(pages[0] ?? "", /:[ \t]*(\d{10,12})[ \t]*$/),
    periodStart,
    periodEnd: isoFromDayMonthYear(period[2]),
    openingBalanceCents: headerBalance(all, "Opening Balance"),
    closingBalanceCents: headerBalance(all, "Closing Balance"),
    transactions: markNonPosting(readRows(words, periodStart), headerBalance(all, "Opening Balance")),
  }
}
