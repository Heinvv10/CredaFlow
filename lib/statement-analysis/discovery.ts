/**
 * Discovery Bank statement text reader.
 *
 * Layout (learned from masked corpus shapes, see .claude.md): page 1 prints
 * "Account holder: …", "From: yyyy-mm-dd To: yyyy-mm-dd" and "Account
 * number: …". The table is headed "Date  Description  Debit  Credit  Balance"
 * on every page; figures print as "R 1,234.56", unsigned in the Debit and
 * Credit columns, the balance with a trailing minus when overdrawn. No opening
 * or closing balance is printed: the opening is derived from the first row
 * (its balance less its amount), so that one row cannot be checked by
 * arithmetic (OPENING_DERIVED sends the statement to a person); the closing is
 * the last row's balance.
 *
 * Rows are read from word boxes: the table is set in a proportional font.
 */
import { parseRandToCents } from "./money"
import { lineMatch, validIso } from "./layout"
import type { PdfWord } from "./pdf-tools"
import type { StatementRead, StatementTransaction } from "./types"
import { labelEdge, lineText, nearestColumn, splitFigures, wordLines } from "./word-table"

type Column = "debit" | "credit" | "balance"
const FIGURE = /^R \d{1,3}(?:,\d{3})*\.\d{2}-?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** "R 1,234.56-" → −123456 cents. */
function cents(text: string): number | null {
  const v = parseRandToCents(text.replace(/^R /, "").replace(/-$/, ""))
  return v === null ? null : text.endsWith("-") ? -v : v
}

const validDate = (iso: string) => validIso(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)))

function columnsOf(line: PdfWord[]): Record<Column, number> | null {
  if (!/^Date Description\b/.test(lineText(line))) return null
  const debit = labelEdge(line, /^Debit$/)
  const credit = labelEdge(line, /^Credit$/)
  const balance = labelEdge(line, /^Balance$/)
  return debit === null || credit === null || balance === null ? null : { debit, credit, balance }
}

function readRows(words: PdfWord[][]): StatementTransaction[] {
  const rows: StatementTransaction[] = []
  let cols: Record<Column, number> | null = null
  words.forEach((pageWords, p) => {
    for (const line of wordLines(pageWords)) {
      cols = columnsOf(line) ?? cols
      if (!cols || !DATE.test(line[0]?.text ?? "")) continue
      const date = validDate(line[0].text)
      const { figures, words: text } = splitFigures(line.slice(1), (t) => FIGURE.test(t))
      const got: Partial<Record<Column, number>> = {}
      for (const f of figures) {
        const col = nearestColumn(f.xMax, cols)
        const v = cents(f.text)
        if (col && v !== null && got[col] === undefined) got[col] = v
      }
      if (!date || (got.debit === undefined && got.credit === undefined)) continue
      rows.push({
        date,
        description: text.map((w) => w.text).join(" "),
        amountCents: Math.abs(got.credit ?? 0) - Math.abs(got.debit ?? 0),
        balanceCents: got.balance ?? null,
        page: p + 1,
      })
    }
  })
  return rows
}

/** Reads a Discovery statement's text layer, or null when it is not one. */
export function readDiscovery(pages: string[], words: PdfWord[][]): StatementRead | null {
  const all = pages.join("\n")
  const period = lineMatch(all, /From:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]+To:[ \t]*(\d{4}-\d{2}-\d{2})/)
  if (!period) return null
  const transactions = readRows(words)
  const first = transactions[0]
  const last = transactions[transactions.length - 1]
  const holder = lineMatch(all, /Account holder:[ \t]*(\S.*?)(?:[ \t]{3,}|$)/)
  const account = lineMatch(all, /Account number:[ \t]*(\d{6,})/)
  return {
    accountHolderName: holder ? holder[1].trim() : null,
    accountNumberLast4: account ? account[1].slice(-4) : null,
    periodStart: validDate(period[1]),
    periodEnd: validDate(period[2]),
    openingBalanceCents: first?.balanceCents != null ? first.balanceCents - first.amountCents : null,
    closingBalanceCents: last?.balanceCents ?? null,
    transactions,
    openingDerived: true,
  }
}
