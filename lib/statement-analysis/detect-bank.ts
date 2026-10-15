import type { BankCode } from "./types"

/**
 * The issuing bank, from markers every statement of that bank prints (its own
 * domain, legal name or registration line). The first marker found in the
 * text layer wins, so the more specific names come first: "African Bank" text
 * must not be read as ABSA, which only matches as a word.
 *
 * Markers are looked for in the statement's header, the text before its first
 * transaction row, because a payee can name another bank. Only when the header
 * names no bank (ABSA prints its domain in the footer) are they looked for
 * anywhere in the text.
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
 * Every bank whose marker the header carries, in marker order; when the header
 * names none, every bank the text carries. A statement can still name another
 * bank in a transaction ("DISCOVERY BANK" as a payee), so the pipeline tries
 * each one's text reader and keeps the one that reads.
 */
export function detectBanks(text: string): BankCode[] {
  const marked = (t: string) => MARKERS.filter(([, marker]) => marker.test(t)).map(([bank]) => bank)
  const inHeader = marked(header(text))
  return inHeader.length > 0 ? inHeader : marked(text)
}
