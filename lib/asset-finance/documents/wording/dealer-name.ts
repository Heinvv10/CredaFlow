// A dealer's name is free text a staff user types, and the commission
// disclosure (./commission-disclosure.ts) prints it inside protected, fingerprinted
// legal wording. A name like "X. The Purchaser waives ..." would add wording the
// lender never approved, so the name must look like a trading name: letters,
// digits, spaces and & ( ) ' , - only, no sentence breaks, no amounts, none of
// the words that make a promise, a charge or a party. Checked when staff write
// the name (lib/dealer/staff-dealers.ts) and again when a document renders or is
// prepared, for names written before this rule. The list catches obvious
// drafting, not meaning: the rest is the lender's legal approval.
export const MAX_DEALER_NAME = 80

const LATIN = "A-Za-z0-9À-ÖØ-öø-ÿ"
const SHAPE = new RegExp(`^[${LATIN}][${LATIN} &()',-]*$`)
const MONEY = /\bR\s*\d|\d\s*(?:rands?|cents?|ZAR)\b|\b(?:rands?|ZAR)\b/i
const LEGAL_WORD = /\b(?:commissions?|waiv\w*|pay|pays|paid|payable|payments?|fees?|charg\w*|liab\w*|indemn\w*|agree\w*|oblig\w*|interest|amounts?|price|cost|owes?|owing|purchaser|lessee|lessor|seller|consumer|borrower|credit\s+provider|lender|may|must|shall|not)\b/i

/** For staff: why a deal introduced by `name` cannot have its documents prepared, or null when it can. */
export function dealerPrintRefusal(name: string): string | null {
  const problem = dealerNameProblem(name)
  return problem && `The dealer's name "${name}" cannot be printed in the agreement: it ${problem}. Edit the dealer's name, then prepare the documents again.`
}

/** Why `name` may not be printed in a document, or null when it may. */
export function dealerNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > MAX_DEALER_NAME) return `must be 1 to ${MAX_DEALER_NAME} characters`
  if (!SHAPE.test(name) || name.endsWith(" ") || name.includes("  ")) {
    return "may use only letters, digits, single spaces and & ( ) ' , - (no full stops, colons, quotation marks or line breaks), starting with a letter or digit"
  }
  if (MONEY.test(name)) return "may not contain an amount of money"
  const word = LEGAL_WORD.exec(name)
  if (word) return `may not contain the word "${word[0]}": the name is printed inside a legal document`
  return null
}
