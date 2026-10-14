/**
 * Standard Bank statement text reader.
 *
 * Layout (learned from masked corpus shapes, see .claude.md): the page head
 * prints "From: dd Mon yy" / "To: dd Mon yy", "Account number: 12 34 567 890 1"
 * and "Account holder: Mr. J SOAP". The table is headed
 *   Date  Description  Payments  Deposits  Balance
 * and opens with "STATEMENT OPENING BALANCE"; each row is "dd Mon yy  reference"
 * with the transaction type on the line below. Payments carry a minus and
 * deposits none, so a figure's sign says which it is; the last figure on a
 * row is its balance. No closing balance is printed: the last page's
 * "Statement Summary" prints total Payments and Deposits, so the closing is
 * opening + deposits + payments, and the rows are checked against the bank's
 * own totals. Without that summary the closing is unknown (the read is
 * unverified). Read from `-layout` text.
 */
import { parseRandToCents } from "./money"
import { isoFromDayMonthYear, lineMatch, MAX_LINE_CHARS, tokens } from "./layout"
import type { StatementRead, StatementTransaction } from "./types"

const FIGURE = /-?\d{1,3}(?:,\d{3})*\.\d{2}(?=\s|$)/g
const ROW = /^\s{0,6}(\d{2} [A-Za-z]{3} \d{2})\s+(.*)$/
const HEADER = /^\s*Date\s+Description\s+Payments\s+Deposits\s+Balance/
/** The page footer opens its line; a payee named "Standard Bank" inside a description is not one. */
const TABLE_END = /^The Standard Bank of South Africa Limited/

/** "05 Jul 26" → 2026-07-05 (statements are this century). */
function isoFromShort(text: string): string | null {
  return isoFromDayMonthYear(text.replace(/ (\d{2})$/, " 20$1"))
}

/** A Statement Summary total: "Payments  -R 1 234.56" / "Deposits  R1,234.56". */
function summaryTotal(text: string, label: "Payments" | "Deposits"): number | null {
  const m = lineMatch(text, new RegExp(`^[ \\t]*${label}[ \\t]+(-?)[ \\t]*R[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2})[ \\t]*$`))
  const v = m ? parseRandToCents(m[2]) : null
  return v === null ? null : m![1] ? -v : v
}

function readRows(pages: string[]): { rows: StatementTransaction[]; opening: number | null } {
  const rows: StatementTransaction[] = []
  let opening: number | null = null
  pages.forEach((page, p) => {
    let moneyFrom: number | null = null
    let continues = false
    for (const line of page.split("\n")) {
      if (line.length > MAX_LINE_CHARS) continue
      if (HEADER.test(line)) {
        moneyFrom = line.indexOf("Payments") - 12
        continue
      }
      if (moneyFrom === null) continue
      if (TABLE_END.test(line)) {
        moneyFrom = null
        continue
      }
      const figures = tokens(line, FIGURE, moneyFrom)
      const last = figures.length ? parseRandToCents(figures[figures.length - 1].text) : null
      // The labels open the description column; a client's reference cannot set them.
      if (/^\s{6,}STATEMENT OPENING BALANCE\b/.test(line)) opening ??= last
      const m = ROW.exec(line)
      if (!m) {
        // The transaction type (and any wrap) prints on the lines right below the row.
        if (continues && line.trim() && figures.length === 0) rows[rows.length - 1].description += ` ${line.trim()}`
        else continues = false
        continue
      }
      continues = false
      const date = isoFromShort(m[1])
      // A long description can run into the money columns: the row's own figures are its last two.
      if (!date || figures.length < 2) continue
      const amount = parseRandToCents(figures[figures.length - 2].text)
      if (amount === null || last === null) continue
      const amountAt = figures[figures.length - 2].end - figures[figures.length - 2].text.length
      rows.push({ date, description: line.slice(line.indexOf(m[2]), amountAt).trim(), amountCents: amount, balanceCents: last, page: p + 1 })
      continues = true
    }
  })
  return { rows, opening }
}

/** Reads a Standard Bank statement's text layer, or null when it is not one. */
export function readStandardBank(pages: string[]): StatementRead | null {
  const all = pages.join("\n")
  const from = lineMatch(all, /From:[ \t]*(\d{2} [A-Za-z]{3} \d{2})\b/)
  const to = lineMatch(all, /To:[ \t]*(\d{2} [A-Za-z]{3} \d{2})\b/)
  if (!from || !to || !/STATEMENT OPENING BALANCE/.test(all)) return null
  const { rows, opening } = readRows(pages)
  const payments = summaryTotal(all, "Payments")
  const deposits = summaryTotal(all, "Deposits")
  const account = lineMatch(all, /Account number:[ \t]*(\d[\d ]{8,}\d)/)
  const holder = lineMatch(all, /Account holder:[ \t]*(?:(?:MR|MRS|MS|MISS|DR|PROF|MNR|MEV)\.?[ \t]+)?(\S.*?)(?:[ \t]{3,}|$)/i)
  return {
    accountHolderName: holder ? holder[1].trim() : null,
    accountNumberLast4: account ? account[1].replace(/ /g, "").slice(-4) : null,
    periodStart: isoFromShort(from[1]),
    periodEnd: isoFromShort(to[1]),
    openingBalanceCents: opening,
    closingBalanceCents: opening !== null && payments !== null && deposits !== null ? opening + deposits + payments : null,
    transactions: rows,
  }
}
