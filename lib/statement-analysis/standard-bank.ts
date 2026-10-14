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
 * row is its balance. Read from `-layout` text.
 */
import { parseRandToCents } from "./money"
import { isoFromDayMonthYear, lineMatch, MAX_LINE_CHARS, tokens } from "./layout"
import type { StatementRead, StatementTransaction } from "./types"

const FIGURE = /-?\d{1,3}(?:,\d{3})*\.\d{2}(?=\s|$)/g
const ROW = /^\s{0,6}(\d{2} [A-Za-z]{3} \d{2})\s+(.*)$/
const HEADER = /^\s*Date\s+Description\s+Payments\s+Deposits\s+Balance/
const TABLE_END = /Standard Bank of South Africa Limited|Pg \d+ of/

/** "05 Jul 26" → 2026-07-05 (statements are this century). */
function isoFromShort(text: string): string | null {
  return isoFromDayMonthYear(text.replace(/ (\d{2})$/, " 20$1"))
}

function readRows(pages: string[]): { rows: StatementTransaction[]; opening: number | null; closing: number | null } {
  const rows: StatementTransaction[] = []
  let opening: number | null = null
  let closing: number | null = null
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
      if (/STATEMENT OPENING BALANCE/.test(line)) opening ??= last
      if (/STATEMENT CLOSING BALANCE/.test(line)) closing = last
      const m = ROW.exec(line)
      if (!m) {
        // The transaction type (and any wrap) prints on the lines right below the row.
        if (continues && line.trim() && figures.length === 0) rows[rows.length - 1].description += ` ${line.trim()}`
        else continues = false
        continue
      }
      continues = false
      const date = isoFromShort(m[1])
      if (!date || figures.length !== 2) continue
      const amount = parseRandToCents(figures[0].text)
      if (amount === null || last === null) continue
      rows.push({ date, description: line.slice(line.indexOf(m[2]), moneyFrom).trim(), amountCents: amount, balanceCents: last, page: p + 1 })
      continues = true
    }
  })
  return { rows, opening, closing }
}

/** Reads a Standard Bank statement's text layer, or null when it is not one. */
export function readStandardBank(pages: string[]): StatementRead | null {
  const all = pages.join("\n")
  const from = lineMatch(all, /From:[ \t]*(\d{2} [A-Za-z]{3} \d{2})\b/)
  const to = lineMatch(all, /To:[ \t]*(\d{2} [A-Za-z]{3} \d{2})\b/)
  if (!from || !to || !/STATEMENT OPENING BALANCE/.test(all)) return null
  const { rows, opening, closing } = readRows(pages)
  const account = lineMatch(all, /Account number:[ \t]*(\d[\d ]{8,}\d)/)
  const holder = lineMatch(all, /Account holder:[ \t]*(?:(?:MR|MRS|MS|MISS|DR|PROF|MNR|MEV)\.?[ \t]+)?(\S.*?)(?:[ \t]{3,}|$)/i)
  return {
    accountHolderName: holder ? holder[1].trim() : null,
    accountNumberLast4: account ? account[1].replace(/ /g, "").slice(-4) : null,
    periodStart: isoFromShort(from[1]),
    periodEnd: isoFromShort(to[1]),
    openingBalanceCents: opening,
    // A statement without the closing line closes on its last row's balance.
    closingBalanceCents: closing ?? rows[rows.length - 1]?.balanceCents ?? null,
    transactions: rows,
  }
}
