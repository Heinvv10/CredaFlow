/**
 * Every threshold and list the credit checks use, in one place. Each value
 * says why it is what it is; change one only with a reason of the same kind.
 *
 * The checks REFER — they raise flags an officer clears — so a value errs
 * toward raising: a false flag costs a minute of an officer's time, a missed
 * one can cost a reckless-lending finding.
 */

/** The clear route and the DB CHECK (migration 20261013120000) both demand this. */
export const CLEAR_REASON_MIN_LENGTH = 15
/** A reason is a sentence or two; this bounds what a clearance writes to the flag and the audit row. */
export const CLEAR_REASON_MAX_LENGTH = 1000

// ── Which statements count ─────────────────────────────────────────────────

/**
 * Statements uploaded this long before the application still count as its
 * evidence; older ones belong to an earlier application. 90 days covers a
 * client who sent three months of statements a few weeks before applying.
 */
export const STATEMENT_UPLOAD_LOOKBACK_DAYS = 90

/** A statement ending more than this before the application is stale (goal §5). */
export const STALE_STATEMENT_DAYS = 45

// ── DOCUMENT_AUTHENTICITY ──────────────────────────────────────────────────

/**
 * Producer/Creator strings each bank's statement system writes, learned from
 * the statement corpus (2026-10-13): every Capitec original was "OpenPDF 2.0.2"
 * with no creator, every FNB original "Compart MFFPDF I/O Filter …" by
 * "Compart Docponent API …". Matched as prefixes so a version bump of the same
 * library does not flag; "" means the bank writes none. A bank not listed here
 * is not producer-checked.
 *
 * Added 2026-10-14 from the same corpus: Nedbank (no producer, OpenText
 * Exstream), ABSA's two systems (BIRT on iText; TargetStream), Standard Bank
 * (PDFlib+PDI by Designer). Discovery writes no metadata on its app statements
 * (8 of 9 files) and StreamServe on the other. A file stripped of its metadata
 * would pass for Discovery, so manual-review.ts sends every PDF without a
 * producer or creator to a person (AUTHENTICITY_UNCHECKED). Standard Bank and
 * Discovery are limited evidence (6–9 files each).
 */
export const EXPECTED_PRODUCERS: Partial<Record<string, { producer: string[]; creator: string[] }>> = {
  CAPITEC: { producer: ["OpenPDF"], creator: [""] },
  FNB: { producer: ["Compart MFFPDF"], creator: ["Compart Docponent"] },
  NEDBANK: { producer: [""], creator: ["OpenText Exstream"] },
  ABSA: { producer: ["iText 2.1.7 by 1T3XT", "TargetStream StreamEDS"], creator: ["BIRT Report Engine", "TargetStream Technologies"] },
  STANDARD_BANK: { producer: ["PDFlib+PDI"], creator: ["Designer"] },
  DISCOVERY: { producer: ["", "StreamServe Communication Server"], creator: ["", "Discovery Bank"] },
}

/**
 * ModDate may trail CreationDate by this much on an untouched file: some
 * generators stamp the two a moment apart while writing. Anything later means
 * the file was saved again after the bank produced it.
 */
export const MODIFIED_AFTER_CREATION_TOLERANCE_MS = 60_000

// ── SALARY_MATCH ───────────────────────────────────────────────────────────

/** Salary lands within this many days of the payslip's pay date (weekends, public holidays). */
export const SALARY_DATE_WINDOW_DAYS = 5
/** Net pay and the credit agree within the larger of these (goal §5). */
export const SALARY_AMOUNT_TOLERANCE_PCT = 2
export const SALARY_AMOUNT_TOLERANCE_CENTS = 5_000
/**
 * A credit at least this share of net pay inside the window is taken to be the
 * salary paid at a different amount (SALARY_AMOUNT_MISMATCH) rather than some
 * other small credit (which leaves NO_SALARY_CREDIT).
 */
export const SALARY_CANDIDATE_MIN_SHARE = 0.5

// ── UNDISCLOSED_DEBT ───────────────────────────────────────────────────────

/** A declared or bureau instalment matches a debit order within this share (goal §5). */
export const INSTALMENT_MATCH_PCT = 10

/** Descriptions that mark a debit order, from the corpus's common vocabulary. */
export const DEBIT_ORDER_MARKERS = /\b(DEBI ?CHECK|DEBIT ORDER|MAGTAPE DEBIT|EFT DEBIT|REGISTERED DEBIT|INTERNAL DEBIT|NAEDO|EDO)\b/i

/** A debit is credit-like when its description carries one of these words (goal §5). */
export const CREDIT_WORD_MARKERS = /\b(LOANS?|FINANCE|CREDIT|LENDING|LENDER)\b/i

/**
 * Credit providers whose debit orders mean an instalment, matched as words in
 * the description. Public company names only; extend with a reason.
 */
export const CREDIT_PROVIDERS = [
  "AFRICAN BANK", "BAYPORT", "CAPITEC LOAN", "DIRECTAXIS", "FINBOND", "OLD MUTUAL FINANCE",
  "REAL PEOPLE", "SANLAM PERSONAL", "WESBANK", "MFC", "RCS", "MOBICRED", "PAYFLEX",
  "PAYJUSTNOW", "LEWIS", "BETTER BOND", "ABSA LOAN", "NEDBANK LOAN", "FNB LOAN",
  "STANDARD BANK LOAN", "CREDIWISE", "LENDPLUS", "PRIMELOANS", "WONGA", "LIME24", "BOODLE",
] as const

// ── RISK_BEHAVIOUR ─────────────────────────────────────────────────────────

/**
 * A debit the bank returned or could not collect. Capitec prints "DebiCheck
 * Insufficient Funds"; FNB prints "EDO Collection Attempt" rows that move no
 * money; both print "Unpaid" for a returned item.
 */
export const RETURNED_DEBIT_MARKERS = /\b(INSUFFICIENT FUNDS|UNPAID|RETURNED (DEBIT|ITEM)|COLLECTION ATTEMPT|DISHONOURED|RD CHEQUE)\b/i

/** Betting and lottery operators licensed in South Africa, matched as words. */
export const GAMBLING_MERCHANTS = [
  "HOLLYWOODBETS", "BETWAY", "SPORTINGBET", "SUPABETS", "LOTTOSTAR", "GBETS", "PLAYABETS",
  "SUNBET", "EASYBET", "10BET", "BETXCHANGE", "YESPLAY", "TOPBET", "WORLD SPORTS BETTING",
  "LOTTO", "ITHUBA", "CASINO",
] as const

/**
 * Gambling above this share of monthly income is a flag. 5% is the point at
 * which it is a budget line rather than an occasional bet, and the corpus
 * shows betting debits are common enough that any-amount would flag most files.
 */
export const GAMBLING_INCOME_SHARE = 0.05

/** Short-term (payday) lenders: any transaction with one is a flag. */
export const PAYDAY_LENDERS = ["WONGA", "LIME24", "LENDPLUS", "PRIMELOANS", "CREDIWISE", "BOODLE", "FASTA", "SPOT MONEY", "CASH CONVERTERS", "ATLAS FINANCE"] as const

/** Matches `name` as whole words inside an upper-cased description. */
export function mentions(description: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(description.toUpperCase())
}
