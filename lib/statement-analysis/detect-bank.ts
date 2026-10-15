import type { BankCode } from "./types"

/**
 * The issuing bank, from markers every statement of that bank prints (its own
 * domain, legal name or registration line). The first marker found in the
 * text layer wins, so the more specific names come first: "African Bank" text
 * must not be read as ABSA, which only matches as a word.
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

export function detectBank(text: string): BankCode | null {
  return detectBanks(text)[0] ?? null
}

/**
 * Every bank whose marker the text carries, in marker order. A statement can
 * name another bank in a transaction ("DISCOVERY BANK" as a payee), so the
 * pipeline tries each one's text reader and keeps the one that reads.
 */
export function detectBanks(text: string): BankCode[] {
  return MARKERS.filter(([, marker]) => marker.test(text)).map(([bank]) => bank)
}
