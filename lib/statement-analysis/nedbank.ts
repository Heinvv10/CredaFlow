/**
 * Nedbank statement text reader.
 *
 * Layout (learned from masked corpus shapes, see .claude.md): page 1's
 * "Account summary" prints "Statement period: dd/mm/yyyy – dd/mm/yyyy", the
 * account number under its "Account number" label, and a Cashflow block with
 * "Opening balance -R99,999.99" / "Closing balance". The table is headed
 *   Tran list no  Date  Description  Fees (R)  Debits (R)  Credits (R)  Balance (R)
 * and repeats on each page. Debits and credits print unsigned in their own
 * columns; the balance carries a minus when overdrawn. The Fees column is an
 * accrual, like FNB's accrued charges: a fee printed there does not move that
 * row's balance (the bank levies it later as its own row), so it is not part
 * of the row's amount. "Opening balance"
 * and "Balance brought forward" rows print only a balance and are not
 * transactions.
 *
 * Rows are read from word boxes: the table is set in a proportional font.
 */
import { parseRandToCents } from "./money"
import { holderFromTitleLine, isoFromDmy, lineMatch, MAX_LINE_CHARS } from "./layout"
import type { PdfWord } from "./pdf-tools"
import type { StatementRead, StatementTransaction } from "./types"
import { labelEdge, lineText, nearestColumn, splitFigures, wordLines } from "./word-table"

type Column = "fees" | "debits" | "credits" | "balance"
const FIGURE = /^-?\d{1,3}(?:,\d{3})*\.\d{2}$/
const DATE = /^\d{2}\/\d{2}\/\d{4}$/
const PERIOD = /Statement period:[ \t]*(\d{2}\/\d{2}\/\d{4})[ \t]*[–-][ \t]*(\d{2}\/\d{2}\/\d{4})/

function columnsOf(line: PdfWord[]): Record<Column, number> | null {
  // The header line starts with its own labels: a description that happens to
  // say "Date" and "Description" must not move the columns.
  if (!/^(Tran list no )?Date Description\b/.test(lineText(line))) return null
  const debits = labelEdge(line, /^Debits$/)
  const credits = labelEdge(line, /^Credits$/)
  const balance = labelEdge(line, /^Balance$/)
  if (debits === null || credits === null || balance === null) return null
  const fees = labelEdge(line, /^Fees$/)
  return fees === null ? { debits, credits, balance } as Record<Column, number> : { fees, debits, credits, balance }
}

function readRow(line: PdfWord[], cols: Record<Column, number>, page: number): StatementTransaction | null {
  const dateAt = line.findIndex((w) => DATE.test(w.text))
  if (dateAt < 0 || dateAt > 1) return null
  const date = isoFromDmy(line[dateAt].text)
  const { figures, words } = splitFigures(line.slice(dateAt + 1), (t) => FIGURE.test(t))
  const got: Partial<Record<Column, number>> = {}
  const inDescription: string[] = []
  for (const f of figures) {
    const col = nearestColumn(f.xMax, cols)
    const cents = parseRandToCents(f.text)
    // A figure under no money column is part of the description ("INV 1,250.00").
    if (!col) {
      inDescription.push(f.text)
      continue
    }
    if (cents === null || got[col] !== undefined) return null
    got[col] = cents
  }
  // Nedbank prints a balance on every row: one without is a misread or an edit
  // (a blank balance lets a +X/−X pair of edits cancel out before the next one).
  if (!date || got.balance === undefined || (got.debits === undefined && got.credits === undefined)) return null
  return {
    date,
    // "*" marks a charge; it is not part of the description.
    description: [...words.filter((w) => w.text !== "*").map((w) => w.text), ...inDescription].join(" "),
    amountCents: (got.credits ?? 0) - Math.abs(got.debits ?? 0),
    balanceCents: got.balance,
    page,
  }
}

function readRows(words: PdfWord[][]): StatementTransaction[] {
  const rows: StatementTransaction[] = []
  let cols: Record<Column, number> | null = null
  words.forEach((pageWords, p) => {
    for (const line of wordLines(pageWords)) {
      cols = columnsOf(line) ?? cols
      if (!cols) continue
      const row = readRow(line, cols, p + 1)
      if (row) rows.push(row)
    }
  })
  return rows
}

function summaryAmount(text: string, label: string): number | null {
  const m = lineMatch(text, new RegExp(`${label}[ \\t]+(-?R-?\\d{1,3}(?:,\\d{3})*\\.\\d{2})`))
  return m ? parseRandToCents(m[1]) : null
}

/** The digits printed under the "Account number" label. */
function accountLast4(page1: string): string | null {
  const lines = page1.split("\n")
  const at = lines.findIndex((l) => l.length <= MAX_LINE_CHARS && /Account type[ \t]+Account number/.test(l))
  const next = lines[at + 1] ?? ""
  const m = at >= 0 && next.length <= MAX_LINE_CHARS ? /(\d{6,})[ \t]*$/.exec(next) : null
  return m ? m[1].slice(-4) : null
}

/** Reads a Nedbank statement's text layer, or null when it is not one. */
export function readNedbank(pages: string[], words: PdfWord[][]): StatementRead | null {
  const all = pages.join("\n")
  const period = lineMatch(all, PERIOD)
  if (!period || !/Opening balance/.test(all)) return null
  return {
    accountHolderName: holderFromTitleLine(pages[0] ?? ""),
    accountNumberLast4: accountLast4(pages[0] ?? ""),
    periodStart: isoFromDmy(period[1]),
    periodEnd: isoFromDmy(period[2]),
    openingBalanceCents: summaryAmount(all, "Opening balance"),
    closingBalanceCents: summaryAmount(all, "Closing balance"),
    transactions: readRows(words),
  }
}
