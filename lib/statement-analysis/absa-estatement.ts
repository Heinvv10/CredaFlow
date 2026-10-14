/**
 * ABSA eStatement (TargetStream) reader; see absa.ts for the other layout.
 *
 * Page 1 prints the period as "1 Jun 2026 to 30 Jun 2026", "Account number
 * 12 3456 7890", and "Balance on <date>" (the closing balance). The table is
 * headed "date  description  transaction amount R  balance R". A dated line
 * names a transaction; its money may print on it or on the undated lines
 * below, one amount per line (a debit and its charge are two), each with the
 * running balance where the bank prints one. Figures use comma decimals and a
 * trailing minus for a debit or an overdrawn balance: "1 234,56-".
 */
import { parseRandToCents } from "./money"
import { isoFromDayMonthYear, lineMatch } from "./layout"
import type { PdfWord } from "./pdf-tools"
import type { StatementRead, StatementTransaction } from "./types"
import { labelEdge, nearestColumn, splitFigures, wordLines } from "./word-table"

const FIGURE = /^\d{1,3}(?: \d{3})*,\d{2}-?$/
const MON = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/
const PERIOD = /^[ \t]*(\d{1,2} [A-Za-z]{3} \d{4}) to (\d{1,2} [A-Za-z]{3} \d{4})[ \t]*$/
const CLOSING = /Balance on \d{1,2} [A-Za-z]{3} \d{4}[ \t]+(\d{1,3}(?: \d{3})*,\d{2}-?)/

/** "1 234,56-" → −123456 cents. */
export function commaCents(text: string): number | null {
  const v = parseRandToCents(text.replace(/-$/, "").replace(",", "."))
  return v === null ? null : text.endsWith("-") ? -v : v
}

/**
 * Fees ABSA prints but has not levied: "( PENDING )" and "DECLINED FEE". The
 * words alone are not enough — a client can type them into a reference — so
 * the balance must confirm it. Rows are taken in runs ending at the next
 * printed balance (or the closing balance): the run's marked rows are
 * non-posting only when that balance is reached without them and not with
 * them. Otherwise nothing is marked and the balance check reports the run.
 */
const NOT_LEVIED = /\(\s*PENDING\s*\)|\bDECLINED FEE\b/i

export function markNonPosting(rows: StatementTransaction[], opening: number | null, closing: number | null): StatementTransaction[] {
  const out = [...rows]
  let base = opening
  let start = 0
  for (let i = 0; i < rows.length; i++) {
    const last = i === rows.length - 1
    const anchor = rows[i].balanceCents ?? (last ? closing : null)
    if (anchor === null) continue
    const run = rows.slice(start, i + 1)
    const marked = run.map((t) => NOT_LEVIED.test(t.description) && t.amountCents !== 0)
    const all = run.reduce((sum, t) => sum + t.amountCents, 0)
    const posted = run.reduce((sum, t, j) => sum + (marked[j] ? 0 : t.amountCents), 0)
    if (base !== null && marked.some(Boolean) && base + all !== anchor && base + posted === anchor) {
      marked.forEach((m, j) => { if (m) out[start + j] = { ...run[j], nonPosting: true } })
    }
    base = anchor
    start = i + 1
  }
  return out
}

type Columns = { amount: number; balance: number; date: number }

function columnsOf(line: PdfWord[]): Columns | null {
  if (!/^date$/i.test(line[0]?.text ?? "") || !line.some((w) => /^description$/i.test(w.text))) return null
  const amount = labelEdge(line, /^amount$/i)
  const balance = labelEdge(line, /^balance$/i)
  return amount === null || balance === null ? null : { amount, balance, date: line[0].xMin }
}

/** The date a line starts with ("1 Jun 2026" at the date column), or null. */
function lineDate(line: PdfWord[], cols: Columns): string | null {
  const [d, m, y] = line
  if (!d || !m || !y || Math.abs(d.xMin - cols.date) > 10 || !/^\d{1,2}$/.test(d.text) || !MON.test(m.text) || !/^\d{4}$/.test(y.text)) return null
  return isoFromDayMonthYear(`${d.text} ${m.text} ${y.text}`)
}

function read(words: PdfWord[][]): { rows: StatementTransaction[]; opening: number | null } {
  const rows: StatementTransaction[] = []
  let opening: number | null = null
  let cols: Columns | null = null
  let date: string | null = null
  let title = ""
  words.forEach((pageWords, p) => {
    for (const line of wordLines(pageWords)) {
      const header = columnsOf(line)
      if (header) {
        cols = header
        continue
      }
      if (!cols) continue
      const dated = lineDate(line, cols)
      const rest = dated ? line.slice(3) : line
      const { figures, words: text } = splitFigures(rest, (t) => FIGURE.test(t))
      const description = text.map((w) => w.text).join(" ")
      if (dated) {
        date = dated
        title = description
      }
      const got: Partial<Record<"amount" | "balance", number>> = {}
      for (const f of figures) {
        const col = nearestColumn(f.xMax, { amount: cols.amount, balance: cols.balance })
        const cents = commaCents(f.text)
        if (col && cents !== null && got[col] === undefined) got[col] = cents
      }
      if (/^Balance Brought Forward$/i.test(description)) {
        if (opening === null && got.balance !== undefined) opening = got.balance
        continue
      }
      if (got.amount === undefined || !date) continue
      rows.push({ date, description: description || title, amountCents: got.amount, balanceCents: got.balance ?? null, page: p + 1 })
    }
  })
  return { rows, opening }
}

export function readAbsaEstatement(pages: string[], words: PdfWord[][]): StatementRead | null {
  const all = pages.join("\n")
  const period = lineMatch(all, PERIOD)
  if (!period || !/Transaction history/i.test(all)) return null
  const { rows, opening } = read(words)
  const closing = lineMatch(all, CLOSING)
  const closingCents = closing ? commaCents(closing[1]) : null
  const account = lineMatch(all, /Account number[ \t]+(\d{2} \d{4} \d{4})\b/)
  return {
    // The address block carries no label to anchor the holder's name on.
    accountHolderName: null,
    accountNumberLast4: account ? account[1].replace(/ /g, "").slice(-4) : null,
    periodStart: isoFromDayMonthYear(period[1]),
    periodEnd: isoFromDayMonthYear(period[2]),
    openingBalanceCents: opening,
    closingBalanceCents: closingCents,
    transactions: markNonPosting(rows, opening, closingCents),
  }
}
