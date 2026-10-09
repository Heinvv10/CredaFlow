// app/api/insurance/decimal-input.ts
//
// Input parsing for the IMS money columns. Postgres does NOT refuse a value
// with more decimals than a `Decimal(p, 2)` column holds — it ROUNDS. A premium
// of R0.001 therefore reaches the DB happily and is stored as R0.00: cover for
// nothing, arrived at by silent truncation. Past the other end the column
// raises `numeric field overflow`, which is a 500 the caller can do nothing
// with. Both ends are refused here, before a statement is built.
//
// Exactness is delegated to lib/insurance/rand-cents.ts, which is already the
// module that turns a rand amount into integer cents without touching a float.
import { toCents, formatCents } from "@/lib/insurance/rand-cents"

/** Ceiling of `Decimal(12, 2)` in cents — R9 999 999 999.99. */
export const DECIMAL_12_2_MAX_CENTS = 999999999999
/** Ceiling of `Decimal(14, 2)` in cents — R999 999 999 999.99. */
export const DECIMAL_14_2_MAX_CENTS = 99999999999999

export type DecimalResult = { ok: true; value: number } | { ok: false; error: string }

/**
 * Parse a rand amount destined for a `Decimal(p, 2)` column. The error names
 * the field, because these parsers run over several fields at once and a bare
 * "must be a number" tells the caller nothing about which one.
 */
export function parseDecimalAmount(
  field: string,
  value: unknown,
  { maxCents, allowZero = false }: { maxCents: number; allowZero?: boolean }
): DecimalResult {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: `${field} must be a finite number` }
  }
  if (Math.abs(value) > maxCents / 100) {
    return { ok: false, error: `${field} must not exceed ${formatCents(maxCents)}` }
  }

  let cents: number
  try {
    cents = toCents(value)
  } catch {
    return {
      ok: false,
      error: `${field} must have at most 2 decimal places — anything finer is rounded away on storage`,
    }
  }

  if (allowZero ? cents < 0 : cents <= 0) {
    return {
      ok: false,
      error: allowZero
        ? `${field} must not be negative`
        : `${field} must be greater than zero once stored at 2 decimal places`,
    }
  }

  return { ok: true, value: cents / 100 }
}

/**
 * Round a validated rand amount to the scale the column stores it at, so a
 * WHERE clause compares like with like. Without this an overlap check on a raw
 * JS number misses the row Postgres already rounded.
 */
export function toStoredScale(value: number): number {
  return Math.round(value * 100) / 100
}
