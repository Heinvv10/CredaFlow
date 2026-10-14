// Entity financial figures (BusinessEntity.annualTurnover / totalAssetValue and
// the EntityFinancials credit-memo figures) are Postgres BIGINT cents, which
// Prisma reads as `bigint`. The application keeps them as JavaScript numbers:
//
//   - inputs are validated as whole cents with |value| <= MAX_FIGURE_CENTS
//     (9e15, below Number.MAX_SAFE_INTEGER ~9.007e15), so a number holds every
//     accepted value exactly;
//   - reads convert with figureFromDb at the Prisma boundary, so nothing past
//     it sees a bigint (JSON.stringify throws on one, and the audit log and
//     API responses are JSON);
//   - JSON responses and audit rows carry these cents as NUMBERS, like every
//     other cents field. Decimal values (rates, DSCR, gearing) stay STRINGS,
//     as Prisma's Decimal serialises.

/** The largest figure accepted, in cents (R90 trillion). */
export const MAX_FIGURE_CENTS = 9_000_000_000_000_000

/** A BIGINT cents read as a number; values written through this module are always exact. */
export function figureFromDb(value: bigint): number {
  return Number(value)
}

export function nullableFigureFromDb(value: bigint | null): number | null {
  return value === null ? null : figureFromDb(value)
}

/** True for whole cents within ±MAX_FIGURE_CENTS (or 0..MAX when `allowNegative` is false). */
export function isFigureCents(value: unknown, allowNegative = false): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value <= MAX_FIGURE_CENTS &&
    value >= (allowNegative ? -MAX_FIGURE_CENTS : 0)
  )
}
