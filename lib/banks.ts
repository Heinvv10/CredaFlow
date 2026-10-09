/**
 * The ONE South African bank vocabulary.
 *
 * `Client.bankName` is written by three paths that each invented their own
 * spelling: the staff form wrote codes ("FNB"), the portal debit-mandate form
 * wrote display names ("FNB (First National Bank)"), and
 * `app/api/clients/[id]/apply-extraction` writes whatever the VLM read off the
 * statement ("First National Bank", "Capitec Bank Limited"). On production that
 * left 6 of 31 clients holding a value no <Select> option could match, and a
 * Radix Select given an unmatched `defaultValue` renders its FIRST option — so
 * opening a client and saving, without touching the bank field, silently
 * rewrote their payout bank to ABSA.
 *
 * `canonicalBankName` lives here rather than beside its caller because a second
 * copy is how the account-type canonicaliser drifted from its Postgres twin and
 * produced a payout the route accepted and the DISBURSED trigger then rejected
 * mid-transaction with 23514. There is exactly one TypeScript copy, and it must
 * stay in step with the DATABASE function `canonicalBankName`
 * (defined in the baseline migration). Do not pin an older
 * filename here — this reference has gone stale twice. Parity across every
 * codepoint from U+0001 to U+3000 is asserted live by
 * lib/compliance/bank-tuple-canonicaliser.integration.test.ts.
 */

/**
 * Compact a bank name to its canonical key.
 *
 * Substring matching is deliberate: a statement prints "FIRSTRAND BANK LIMITED
 * t/a FNB" or "Capitec Bank Limited", never the bare brand. An unknown bank
 * returns its own compacted form, so two spellings of the same unlisted bank
 * still match each other and a genuine mismatch still fails closed.
 */
export function canonicalBankName(value: string): string {
  // ASCII-only, strip THEN lowercase — byte-identical to the Postgres twin
  // `canonicalBankName`. See the long note in
  // lib/compliance/debit-mandate.ts on why class-matching Postgres is
  // unreachable and ASCII is the only parity that holds.
  //
  // HISTORY, not current behaviour: Postgres used to KEEP the Ø, so "Bank Ø"
  // and "Bank" were two banks there and one here — TS accepted a payout the
  // trigger then refused with 23514. A later migration aligned the DB to
  // this side, so both now see one bank. That alignment LOOSENED Postgres
  // rather than tightening TypeScript, because the strict version cannot be
  // expressed in JavaScript; the account number is still matched exactly
  // against the verified statement and is what stops money reaching the wrong
  // account.
  const compact = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
  // FNB is a division of FirstRand Bank Limited, so an FNB statement is often
  // printed under the registered name ("FIRSTRAND BANK LIMITED t/a FNB") rather
  // than the brand. Without this a genuine FNB consumer canonicalises to
  // "firstrandbanklimitedtafnb", matches nothing, and is refused at payout —
  // and FNB is the most common bank in the book (19 of 45 statements).
  //
  // FirstRand also trades as RMB and WesBank. Mapping those to fnb too is
  // deliberate and safe: bankName is one of FOUR fields the payout tuple must
  // match, and the account number and branch code carry the real identity. A
  // wrong bank label cannot on its own admit a payout to the wrong account.
  if (
    compact.includes("firstnationalbank")
    || compact.includes("firstrand")
    || compact === "fnb"
  ) return "fnb"
  if (compact.includes("standardbank")) return "standardbank"
  if (compact.includes("absa")) return "absa"
  if (compact.includes("nedbank")) return "nedbank"
  if (compact.includes("capitec")) return "capitec"
  if (compact.includes("africanbank")) return "africanbank"
  if (compact.includes("discoverybank")) return "discoverybank"
  if (compact.includes("tymebank")) return "tymebank"
  if (compact.includes("bidvestbank")) return "bidvestbank"
  if (compact.includes("investec")) return "investec"
  return compact
}

/**
 * Every bank the canonicaliser can name, and the ONLY list any picker may
 * offer. Bidvest and Investec were absent from the staff form while both
 * canonicalisers already knew them, so a consumer banking with either could be
 * matched at disbursement but never recorded in the first place.
 *
 * `code` is what gets stored and submitted; `canonical` is the tie back to
 * canonicalBankName and is asserted in lib/banks.test.ts, so adding a bank here
 * without teaching the canonicaliser fails the suite rather than shipping a
 * label nothing can match.
 */
export const SA_BANKS = [
  { code: "ABSA", label: "ABSA", canonical: "absa" },
  { code: "FNB", label: "FNB", canonical: "fnb" },
  { code: "NEDBANK", label: "Nedbank", canonical: "nedbank" },
  { code: "STANDARD_BANK", label: "Standard Bank", canonical: "standardbank" },
  { code: "CAPITEC", label: "Capitec", canonical: "capitec" },
  { code: "AFRICAN_BANK", label: "African Bank", canonical: "africanbank" },
  { code: "TYME_BANK", label: "TymeBank", canonical: "tymebank" },
  { code: "DISCOVERY_BANK", label: "Discovery Bank", canonical: "discoverybank" },
  { code: "BIDVEST_BANK", label: "Bidvest Bank", canonical: "bidvestbank" },
  { code: "INVESTEC", label: "Investec", canonical: "investec" },
] as const

export type BankCode = (typeof SA_BANKS)[number]["code"]

/**
 * Resolve any stored spelling to the code a picker can select.
 *
 * Returns null for a bank outside the vocabulary. Callers seeding a <Select>
 * MUST pass that null through as `undefined` rather than defaulting: showing
 * the placeholder says "not set", while falling back to the first option says
 * "ABSA" about a client who banks elsewhere.
 */
export function toBankCode(value: string | null | undefined): BankCode | null {
  if (!value?.trim()) return null
  const canonical = canonicalBankName(value)
  return SA_BANKS.find((bank) => bank.canonical === canonical)?.code ?? null
}

/** The human label for a stored value, falling back to the value itself. */
export function bankLabel(value: string | null | undefined): string {
  if (!value?.trim()) return ""
  const code = toBankCode(value)
  return SA_BANKS.find((bank) => bank.code === code)?.label ?? value
}
