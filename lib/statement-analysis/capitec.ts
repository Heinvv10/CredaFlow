/**
 * Capitec "Main Account Statement" text reader.
 *
 * Layout (learned from masked corpus shapes, see .claude.md): page 1 carries
 * "From Date:/To Date:" and "Opening Balance:/Closing Balance:" as R-prefixed
 * amounts. Rows live under "Transaction History" in a table headed
 *   Date  Description  Category  Money In  Money Out  Fee*  Balance
 * which repeats on each page and ends at the "* Includes VAT" footnote. Money
 * In is unsigned, Money Out and Fee carry a minus, and every row prints its
 * running balance, which moves by in + out + fee.
 */
import { parseRandToCents } from "./money"
import { holderFromTitleLine, isoFromDmy, last4, leftSegment, lineMatch, MAX_LINE_CHARS, tokens } from "./layout"
import type { StatementRead, StatementTransaction } from "./types"

const AMOUNT_TOKEN = /-?\d{1,3}(?: \d{3})*\.\d{2}/g
const ROW_DATE = /^\s*(\d{2}\/\d{2}\/\d{4})\s+(.*)$/
const TABLE_HEADER = /^\s*Date\s+Description\s+(Category\s+)?Money In\s+Money Out/
const TABLE_END = /Includes VAT|Client Care Centre|Unique Document No/

function headerAmount(text: string, label: string): number | null {
  const m = lineMatch(text, new RegExp(`${label}:[ \\t]*(-?R?-?\\d[\\d ]*\\.\\d{2})`))
  return m ? parseRandToCents(m[1]) : null
}

function headerDate(text: string, label: string): string | null {
  const m = lineMatch(text, new RegExp(`${label}:[ \\t]*(\\d{2}/\\d{2}/\\d{4})`))
  return m ? isoFromDmy(m[1]) : null
}

function holder(page1: string): string | null {
  // The holder's name prints left of "Capitec Bank Limited" in the address block.
  for (const line of page1.split("\n").slice(0, 12)) {
    if (/Capitec Bank Limited\s*$/.test(line)) {
      const seg = leftSegment(line)
      if (seg && !/Capitec/i.test(seg)) return seg
    }
  }
  return holderFromTitleLine(page1)
}

interface Columns {
  /** Where the money columns begin: amounts are read right of this. */
  moneyFrom: number
}

function columnsOf(header: string): Columns {
  const category = header.indexOf("Category")
  return { moneyFrom: category >= 0 ? category + "Category".length : header.indexOf("Money In") - 2 }
}

function readRows(pages: string[]): StatementTransaction[] {
  const rows: StatementTransaction[] = []
  pages.forEach((page, p) => {
    let cols: Columns | null = null
    for (const line of page.split("\n")) {
      if (line.length > MAX_LINE_CHARS) continue
      if (TABLE_HEADER.test(line)) {
        cols = columnsOf(line)
        continue
      }
      if (!cols) continue
      if (TABLE_END.test(line)) {
        cols = null
        continue
      }
      const m = ROW_DATE.exec(line)
      if (!m) {
        // A wrapped description: belongs to the row above, carries no money.
        if (rows.length && line.trim() && tokens(line, AMOUNT_TOKEN, cols.moneyFrom).length === 0) {
          rows[rows.length - 1].description += ` ${line.trim()}`
        }
        continue
      }
      const date = isoFromDmy(m[1])
      const money = tokens(line, AMOUNT_TOKEN, cols.moneyFrom)
      if (!date || money.length < 2) continue
      const balance = parseRandToCents(money[money.length - 1].text)
      const parts = money.slice(0, -1).map((t) => parseRandToCents(t.text))
      if (balance === null || parts.some((v) => v === null)) continue
      const descEnd = line.length - line.slice(cols.moneyFrom).length
      rows.push({
        date,
        description: line.slice(line.indexOf(m[2]), descEnd).replace(/\s{2,}.*$/, "").trim(),
        amountCents: (parts as number[]).reduce((a, b) => a + b, 0),
        balanceCents: balance,
        page: p + 1,
      })
    }
  })
  return rows
}

/** Reads a Capitec statement's text layer, or null when it is not one. */
export function readCapitec(pages: string[]): StatementRead | null {
  const all = pages.join("\n")
  if (!/Transaction History/.test(all) || !/Opening Balance:/.test(all)) return null
  const transactions = readRows(pages)
  return {
    accountHolderName: holder(pages[0] ?? ""),
    accountNumberLast4: last4(pages[0] ?? "", /^[ \t]*Account(?::[^\d]*?)?[ \t]+(\d{6,})/),
    periodStart: headerDate(all, "From Date"),
    periodEnd: headerDate(all, "To Date"),
    openingBalanceCents: headerAmount(all, "Opening Balance"),
    closingBalanceCents: headerAmount(all, "Closing Balance"),
    transactions,
  }
}
