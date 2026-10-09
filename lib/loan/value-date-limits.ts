/**
 * Pure value-date limits, with NO imports.
 *
 * Kept in a leaf module because capture screens are client components and need
 * these numbers to label their fields. Reaching them through
 * `lib/loan/value-date.ts` drags `settlement.ts` → `balances.ts` — the whole
 * loan calculator — into the client bundle to read one integer, and any
 * server-only import added anywhere in that chain would then break the build.
 *
 * The rules that USE these live in `lib/loan/value-date.ts`. Only the constants
 * belong here.
 */

/**
 * Back-dating is bounded by the RAND it writes off, not by days and not by a
 * fraction of interest. See `lib/loan/value-date.ts` for why both this and the
 * erasure clause are required — each alone is exploitable in one direction.
 */
export const MAX_UNREVIEWED_REBATE_CENTS = 10_000

/**
 * Rebating this share or more of the interest earned to date is treated as
 * erasing it, whatever the rand value.
 */
export const REBATE_ERASURE_FRACTION = 0.9

/** Matches the manual KYC exception's floor so overrides read alike. */
export const VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS = 20
