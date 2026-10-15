import type { BankCode } from "./types"

/**
 * The issuing bank, from markers every statement of that bank prints (its own
 * domain, legal name or registration line). The first marker found in the
 * text layer wins, so the more specific names come first: "African Bank" text
 * must not be read as ABSA, which only matches as a word.
 *
 * Banks the statement's header (the text before its first transaction row)
 * names come first, because a payee can name another bank; every other bank
 * the text names follows, since some banks (ABSA, Discovery, Capitec) print
 * their marker only in the footer and a header line (a holder's "c/o" address)
 * can name the wrong one. For a footer-only bank a payee's bank can still be
 * tried first: the pipeline keeps the reader that reads.
 */
const MARKERS: Array<[BankCode, RegExp]> = [
  ["CAPITEC", /capitecbank\.co\.za|Capitec Bank Limited/i],
  ["FNB", /fnb\.co\.za|First National Bank/i],
  ["AFRICAN_BANK", /africanbank\.co\.za|African Bank Limited/i],
  ["DISCOVERY", /discovery\.co\.za|Discovery Bank/i],
  ["TYMEBANK", /tymebank\.co\.za|TymeBank|gotyme/i],
  ["NEDBANK", /nedbank\.co\.za|Nedbank Limited/i],
  ["STANDARD_BANK", /standardbank\.co\.za|Standard Bank of South Africa/i],
  ["INVESTEC", /investec\.co(m|\.za)/i],
  ["ABSA", /absa\.co\.za|\bAbsa Bank\b/i],
]

/** A transaction row starts with a date (dd Mon, dd/mm/yyyy, yyyy-mm-dd) and prints an amount. */
const ROW_DATE = /^\s*(?:\d{1,2}[ /-](?:[A-Za-z]{3}|\d{2})(?:[ /-]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/
const AMOUNT = /\d[.,]\d{2}(?!\d)/

/** The lines above the first transaction row; all of them when the text has no row. */
function header(text: string): string {
  const lines = text.split("\n")
  const firstRow = lines.findIndex((l) => ROW_DATE.test(l) && AMOUNT.test(l))
  return firstRow < 0 ? text : lines.slice(0, firstRow).join("\n")
}

export function detectBank(text: string): BankCode | null {
  return detectBanks(text)[0] ?? null
}

/**
 * Every bank whose marker the text carries: the header's first, then the rest,
 * each group in marker order. The pipeline tries each one's text reader and
 * keeps the one that reads.
 */
export function detectBanks(text: string): BankCode[] {
  const marked = (t: string) => MARKERS.filter(([, marker]) => marker.test(t)).map(([bank]) => bank)
  const inHeader = marked(header(text))
  return [...inHeader, ...marked(text).filter((b) => !inHeader.includes(b))]
}
