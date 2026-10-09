// Exact rand arithmetic for the IMS money paths.
//
// MONEY REPRESENTATION — the choice, stated once so every caller inherits it:
// premiums and sums assured are held internally as INTEGER CENTS (`number`),
// never as a JS float in rands. Prisma returns `@db.Decimal(12, 2)` columns as
// Decimal objects; those are converted here through `toFixed(2)` — a string —
// so no value ever passes through binary floating point on the way in. Cents
// are safe as `number`: R99 999 999 999.99 is ~1e13, three orders of magnitude
// below Number.MAX_SAFE_INTEGER.
//
// The one place a product of two money values is needed (PER_MILLE rating)
// goes through `mulDivCents`, which multiplies in BigInt and rounds half-up on
// the final cent. Nothing else in the IMS may multiply money.

/**
 * Anything that can be converted to cents without touching a float:
 * a fixed-point string, a Prisma `Decimal` (via `toFixed`), or a `number`
 * that already sits on a whole cent.
 */
export type MoneyInput = string | number | { toFixed(decimalPlaces: number): string }

const RAND_STRING = /^-?\d+(\.\d{1,2})?$/

/** Parse a rand amount to exact integer cents. Throws rather than rounding. */
export function toCents(value: MoneyInput): number {
  const text = moneyText(value)

  if (!RAND_STRING.test(text)) {
    if (/^-?\d+\.\d{3,}$/.test(text)) {
      throw new Error(`Money value "${text}" carries more than 2 decimal places`)
    }
    throw new Error(`Money value "${text}" is not a plain rand amount`)
  }

  const negative = text.startsWith("-")
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".")
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))

  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Money value "${text}" is outside the safe integer range in cents`)
  }
  return negative ? -cents : cents
}

function moneyText(value: MoneyInput): string {
  if (typeof value === "string") return value.trim()

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Money value ${String(value)} is not finite`)
    }
    // String(number) is the shortest round-tripping representation, so a
    // literal written with three decimals still reads as three decimals here
    // and is refused by toCents rather than silently rounded.
    return String(value)
  }

  if (value && typeof value.toFixed === "function") {
    return value.toFixed(2)
  }
  throw new Error("Money value is not a string, number, or Decimal")
}

/** Render integer cents as a canonical 2dp rand string, safe for a Decimal column. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Cents value ${String(cents)} is not a safe integer`)
  }
  const negative = cents < 0
  const abs = Math.abs(cents)
  const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`
  return negative ? `-${text}` : text
}

/** Sum integer cents, refusing an overflow rather than returning a drifting float. */
export function addCents(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total)) {
    throw new Error("Cents total is outside the safe integer range")
  }
  return total
}

// BigInt literals (`2n`) need an ES2020 target; this project's tsconfig sits
// below that, so BigInt values are constructed rather than written literally.
const BIG_ZERO = BigInt(0)
const BIG_TWO = BigInt(2)

/**
 * `(a * b) / divisor` over integer cents, multiplied in BigInt and rounded
 * half-up to the nearest cent. Used for PER_MILLE rating, where the divisor is
 * 100_000 (1000 rand-units of cover, expressed in cents).
 */
export function mulDivCents(a: number, b: number, divisor: number): number {
  if (!Number.isSafeInteger(divisor) || divisor <= 0) {
    throw new Error("mulDivCents divisor must be a positive safe integer")
  }
  const bigDivisor = BigInt(divisor)

  const product = BigInt(a) * BigInt(b)
  const negative = product < BIG_ZERO
  const abs = negative ? -product : product
  // Half-up: add half the divisor before the integer division.
  const rounded = (abs * BIG_TWO + bigDivisor) / (bigDivisor * BIG_TWO)
  const result = Number(negative ? -rounded : rounded)

  if (!Number.isSafeInteger(result)) {
    throw new Error("mulDivCents result is outside the safe integer range")
  }
  return result
}
