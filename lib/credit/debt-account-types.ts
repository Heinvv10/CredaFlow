/**
 * The ONE vocabulary for `ExistingDebtObligation.accountType`.
 *
 * That column is a free-text `String`, and four surfaces used to write four
 * different vocabularies into it: the affordability panel wrote Title Case
 * ("Home Loan", "Microfinance"), the client wizard wrote UPPER_SNAKE, the
 * client detail section wrote lower_snake, and the wizard validator mirrored a
 * fifth hand-copied list. Three of them could end up in the same column at
 * once.
 *
 * The visible failure: re-submitting an application rebuilds its debt snapshot
 * from the client's rows, so a lower_snake value landed in a `<select>` whose
 * options were Title Case. A select whose value matches no option displays
 * option[0] — "Home Loan" — so staff read a home loan where the record said
 * personal_loan, on an NCA s.81 affordability input. Correcting it meant
 * re-picking every row by hand.
 *
 * Anything reading or writing an account type goes through here.
 */
export const DEBT_ACCOUNT_TYPES = [
  { value: "HOME_LOAN", label: "Home loan" },
  { value: "VEHICLE_FINANCE", label: "Vehicle finance" },
  { value: "PERSONAL_LOAN", label: "Personal loan" },
  { value: "CREDIT_CARD", label: "Credit card" },
  { value: "STORE_ACCOUNT", label: "Store account" },
  { value: "CLOTHING_ACCOUNT", label: "Clothing account" },
  { value: "MICROFINANCE", label: "Microfinance" },
  { value: "OTHER", label: "Other" },
] as const

export type DebtAccountType = (typeof DEBT_ACCOUNT_TYPES)[number]["value"]

export const DEBT_ACCOUNT_TYPE_VALUES: Set<string> = new Set(
  DEBT_ACCOUNT_TYPES.map((t) => t.value),
)

const LABELS = new Map<string, string>(
  DEBT_ACCOUNT_TYPES.map((t) => [t.value, t.label]),
)

/**
 * Renames, not spelling variants — these cannot fold by case and spacing rules,
 * so without them the legacy rows read as unrecognised.
 */
const LEGACY_ALIASES = new Map<string, DebtAccountType>([
  ["VEHICLE", "VEHICLE_FINANCE"],
  ["STORE_CARD", "STORE_ACCOUNT"],
])

/**
 * Folds any vocabulary onto the canonical value, or returns null when the value
 * is not recognisable.
 *
 * Null rather than "OTHER" on purpose: "Other" is an answer the consumer gave.
 * Substituting it for a value we failed to parse would write a fabricated
 * declaration into affordability evidence — the caller must show the value is
 * unrecognised and let a human resolve it.
 */
export function normaliseDebtAccountType(
  raw: string | null | undefined,
): DebtAccountType | null {
  if (typeof raw !== "string") return null
  const folded = raw.trim().toUpperCase().replace(/[\s-]+/g, "_")
  if (!folded) return null
  if (DEBT_ACCOUNT_TYPE_VALUES.has(folded)) return folded as DebtAccountType
  return LEGACY_ALIASES.get(folded) ?? null
}

/**
 * Snapshot the types a set of debt rows arrived with, so a later edit can tell
 * a real change from a re-render of the same meaning.
 *
 * Keyed by ROW IDENTITY, never by position. An editor that adds or removes rows
 * shifts every later index, so a positional key silently pairs a row with a
 * different debt's original bytes — and then writes them, moving the very
 * approval fingerprint this preservation exists to protect.
 *
 * Rows with no identity are new: there are no stored bytes to keep, so they are
 * excluded rather than given a synthetic key that could collide with a real row.
 */
export function captureOriginalDebtAccountTypes(
  rows: readonly { key: string | null | undefined; type: string }[],
): Map<string, string> {
  const originals = new Map<string, string>()
  for (const row of rows) {
    if (!row.key) continue
    if (!originals.has(row.key)) originals.set(row.key, row.type)
  }
  return originals
}

/**
 * Choose what to persist for a row whose type was rendered canonically.
 *
 * The stored string is hashed into `affordabilityDebtPayload`, so it reaches
 * the approval `decisionFingerprint` that agreement generation, signing and
 * disbursement each re-derive from LIVE rows and compare against the locked
 * snapshot. Writing `PERSONAL_LOAN` over a stored `personal_loan` says nothing
 * new about the consumer's debt, but it moves that fingerprint — which blocks
 * payout on a loan that was already approved.
 *
 * So when the chosen value means what the stored one already meant, the stored
 * bytes are kept. A real change is written canonically.
 *
 * Note this is why the mixed column must NOT be backfilled: rewriting rows in
 * bulk breaks the fingerprint of every in-flight approval at once.
 */
export function preserveOriginalDebtAccountType(
  chosen: string,
  original: string | null | undefined,
): string {
  const normalisedChosen = normaliseDebtAccountType(chosen)
  // Two unrecognised values both normalise to null. Treating that as a match
  // would pin an unparseable string in place permanently, defeating the
  // correction the "Unrecognised" label exists to prompt.
  if (!normalisedChosen) return chosen
  if (typeof original !== "string") return chosen
  return normalisedChosen === normaliseDebtAccountType(original) ? original : chosen
}

/**
 * Display label for any stored value. An unrecognised value is named as such,
 * carrying the raw text so staff can see what is actually on the record.
 */
export function debtAccountTypeLabel(raw: string | null | undefined): string {
  const normalised = normaliseDebtAccountType(raw)
  if (!normalised) return `Unrecognised (${(raw ?? "").trim() || "blank"})`
  return LABELS.get(normalised) ?? normalised
}
