/**
 * ABSA statement text reader. ABSA issues two layouts (learned from masked
 * corpus shapes, see .claude.md):
 *
 * "Transaction History" (BIRT/iText): "Statement for the Period yyyy-mm-dd -
 * yyyy-mm-dd", rows "yyyy-mm-dd  Description  Amount  Balance" with R-prefixed
 * signed figures ("-R1 234.56"), descriptions wrapping onto undated lines, and
 * "Balance Brought Forward" / "Balance Carried Forward" lines. The brought-
 * forward line prints no figure, so the opening balance is derived from the
 * first row (its balance less its amount): that one row cannot be checked by
 * arithmetic (OPENING_DERIVED sends the statement to a person), every later
 * row can. The closing is the last "Balance Carried Forward" figure only. Pending and declined fees print with an
 * amount but leave the balance where it was: they are `nonPosting` (as FNB's
 * collection attempts) when the balance confirms it (markNonPosting). Read from
 * `-layout` text: the R prefix and
 * the sign make each figure unambiguous, and a row's last two are its amount
 * and balance.
 *
 * eStatement (TargetStream): "d Mon yyyy to d Mon yyyy", comma decimals with a
 * trailing minus on debits ("1 234,56-"), and a dated line whose charges may
 * print on the undated lines below it, each with its own amount. Read from
 * word boxes (absa-estatement.ts).
 */
import { readAbsaEstatement } from "./absa-estatement"
import { markNotLevied } from "./absa-not-levied"
import { parseRandToCents } from "./money"
import { leftSegment, lineMatch, MAX_LINE_CHARS, tokens, validIso } from "./layout"
import type { PdfWord } from "./pdf-tools"
import type { StatementRead, StatementTransaction } from "./types"

const FIGURE = /-?R-?\d{1,3}(?: \d{3})*\.\d{2}/g
const ROW = /^\s{0,4}(\d{4}-\d{2}-\d{2})\s+(.*)$/
const HEADER = /^\s*Date\s+Transaction Description\s+Amount\s+Balance/
/** Where the bank prints them: at the start of a line, never inside a description. */
const TABLE_END = /^\s*Balance Carried Forward|^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+Page\s+\d+\s+of\s+\d+/
const PERIOD = /Statement for the Period[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+-[ \t]+(\d{4}-\d{2}-\d{2})/

const validDate = (iso: string) => validIso(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)))
/** A wrapped description stops growing here: statement descriptions are a line or two. */
const MAX_DESCRIPTION_CHARS = 300

function readRows(pages: string[]): StatementTransaction[] {
  const rows: StatementTransaction[] = []
  pages.forEach((page, p) => {
    let inTable = false
    for (const line of page.split("\n")) {
      if (line.length > MAX_LINE_CHARS) continue
      if (HEADER.test(line)) {
        inTable = true
        continue
      }
      if (!inTable) continue
      if (TABLE_END.test(line)) {
        inTable = false
        continue
      }
      const m = ROW.exec(line)
      const figures = tokens(line, FIGURE)
      if (!m) {
        // A wrapped description: belongs to the row above, carries no money.
        const last = rows[rows.length - 1]
        if (last && line.trim() && figures.length === 0 && !/Balance Brought Forward/.test(line) && last.description.length < MAX_DESCRIPTION_CHARS) {
          last.description += ` ${line.trim()}`
        }
        continue
      }
      const date = validDate(m[1])
      if (!date || figures.length < 2) continue
      const amount = parseRandToCents(figures[figures.length - 2].text)
      const balance = parseRandToCents(figures[figures.length - 1].text)
      if (amount === null || balance === null) continue
      const amountToken = figures[figures.length - 2]
      const descEnd = amountToken.end - amountToken.text.length
      rows.push({ date, description: line.slice(line.indexOf(m[2]), descEnd).trim(), amountCents: amount, balanceCents: balance, page: p + 1 })
    }
  })
  return rows
}

function carriedForward(text: string): number | null {
  let last: number | null = null
  for (const line of text.split("\n")) {
    if (line.length > MAX_LINE_CHARS || !/^\s*Balance Carried Forward/.test(line)) continue
    const f = tokens(line, FIGURE)
    if (f.length) last = parseRandToCents(f[f.length - 1].text)
  }
  return last
}

/** The holder prints left of "ABSA" in the address block, the account number below it. */
function holderAndAccount(page1: string): { holder: string | null; last4: string | null } {
  const lines = page1.split("\n").slice(0, 30)
  const at = lines.findIndex((l) => l.length <= MAX_LINE_CHARS && /\S\s{3,}ABSA\s*$/.test(l))
  if (at < 0) return { holder: null, last4: null }
  const account = /\s(\d{9,})\s*$/.exec(lines[at + 1] ?? "")
  return { holder: leftSegment(lines[at]) || null, last4: account ? account[1].slice(-4) : null }
}

function readTransactionHistory(pages: string[]): StatementRead | null {
  const all = pages.join("\n")
  const period = lineMatch(all, PERIOD)
  if (!period || !/Transaction History/.test(all)) return null
  const rows = readRows(pages)
  const first = rows[0]
  // The opening is derived from the first row, so that row is never one to skip.
  const opening = first?.balanceCents != null ? first.balanceCents - first.amountCents : null
  // No printed closing, no closing: a missing "Balance Carried Forward" leaves the read unverified.
  const closing = carriedForward(all)
  const transactions = [...rows.slice(0, 1), ...markNotLevied(rows.slice(1), first?.balanceCents ?? null, closing)]
  const { holder, last4 } = holderAndAccount(pages[0] ?? "")
  return {
    accountHolderName: holder,
    accountNumberLast4: last4,
    periodStart: validDate(period[1]),
    periodEnd: validDate(period[2]),
    openingBalanceCents: opening,
    closingBalanceCents: closing,
    transactions,
    openingDerived: true,
  }
}

/** Reads either ABSA layout's text layer, or null when it is neither. */
export function readAbsa(pages: string[], words: PdfWord[][]): StatementRead | null {
  return readTransactionHistory(pages) ?? readAbsaEstatement(pages, words)
}
