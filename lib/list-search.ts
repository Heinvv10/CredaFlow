/**
 * Amount matching for the staff list search bars.
 *
 * Text fields (names, references, product names) are matched as substrings,
 * which is what a reader expects of text. Amounts are NOT: an amount is an
 * identity, not a string. The first version of these filters compared
 * `String(rands).includes(digits)`, so searching "50" returned R500, R1,500 and
 * R5,000 alongside the R50 loan the user was actually looking for.
 *
 * The rules here:
 *   "50"        matches R50.00 and R50.99 — nothing else
 *   "1500"      matches every cent value inside R1,500 (…00 through …99)
 *   "1500.50"   matches R1,500.50 exactly
 *
 * UNSIGNED ONLY. A minus sign is stripped with the rest of the punctuation, so
 * a negative amount can never be found and "-50" matches a POSITIVE R50. Every
 * field wired to this today is non-negative — a reversed payment keeps its
 * positive `amount` and flips a flag rather than negating. `BankTransaction
 * .amountCents` IS signed, so teach this module about the sign before pointing
 * a search at it; the tests below pin the current behaviour so that wiring
 * fails loudly here rather than silently returning nothing on the screen.
 *
 * A whole-rand query matching the cents inside it is deliberate: staff read
 * "R 1,500.00" off the screen and type "1500". Demanding the cents would make
 * the common case fail.
 *
 * TWO formats are accepted because the app renders money two ways: `formatZAR`
 * gives "R 1,500.50" (comma thousands, point decimal) on five screens, while
 * the payments screen has its own `toLocaleString("en-ZA")` formatter giving
 * "1 500,50" — true SA convention, space thousands and COMMA decimal. Pasting
 * what the payments screen displayed matched nothing until this handled both.
 * The separator that ends the amount followed by one or two digits is the
 * decimal; everything else is grouping, and grouping that is not real grouping
 * is refused rather than read as a number the query does not name. A point is
 * accepted as a grouping separator too ("1.500" reads as R1,500) — neither
 * formatter emits that, but the rule is symmetric rather than carving out a
 * third convention.
 */

interface ParsedAmount {
  /** Rand figure, when the query named no cents. */
  rand: number
  /** Exact cent figure, when the query named cents. */
  cents: number
  /** True when the query named no cents and should match the whole rand. */
  whole: boolean
}

function parseAmountQuery(query: string): ParsedAmount | null {
  // Drop the currency symbol and any other decoration, keeping only digits and
  // the characters either formatter uses as a separator.
  const raw = query.replace(/[^\d.,\s]/g, "").trim()
  if (!/\d/.test(raw)) return null

  // The decimal separator is the one that ENDS the amount followed by one or
  // two digits — "500,00" is five hundred rand, while "1,500" is fifteen
  // hundred. Three trailing digits are never cents.
  const decimalMatch = raw.match(/[.,](\d{1,2})$/)
  const intPart = decimalMatch ? raw.slice(0, -decimalMatch[0].length) : raw
  const decPart = decimalMatch ? decimalMatch[1] : ""

  const groups = intPart.split(/[.,\s]/).filter((g, i) => !(i === 0 && g === ""))
  if (groups.length > 1) {
    // Real grouping: the leading group is 1-3 digits, every later one exactly
    // 3. This is what refuses "15.00.50" and "1,50,000" instead of guessing.
    if (groups[0].length < 1 || groups[0].length > 3) return null
    if (groups.slice(1).some((g) => g.length !== 3)) return null
  }
  if (groups.some((g) => g === "")) return null

  const digits = groups.join("")
  const rand = digits === "" ? 0 : Number.parseInt(digits, 10)
  if (!Number.isFinite(rand)) return null

  if (decPart === "") return { rand, cents: rand * 100, whole: true }

  const centPart = Number.parseInt(decPart.padEnd(2, "0"), 10)
  return { rand, cents: rand * 100 + centPart, whole: false }
}

/**
 * True when `query` names the amount `cents` (a value stored in CENTS, which
 * is how loans, applications, payments and collections store money here).
 * False when the query is not an amount at all, so callers can fall through to
 * their text matching.
 */
export function matchesCentsAmount(query: string, cents: number): boolean {
  const parsed = parseAmountQuery(query)
  if (!parsed) return false
  if (parsed.whole) return Math.trunc(cents / 100) === parsed.rand
  return cents === parsed.cents
}

/**
 * As `matchesCentsAmount`, for an amount stored in RANDS — insurance
 * `premiumAmount` and `sumAssured` are `Decimal(12, 2)`, not cents. Rounding
 * to cents first also absorbs the float error a Decimal picks up on its way
 * through `Number()`.
 */
export function matchesRandAmount(query: string, rand: number): boolean {
  return matchesCentsAmount(query, Math.round(rand * 100))
}
