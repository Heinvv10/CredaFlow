// Ceiling is 100% of principal. A rate above that is always a typo — most
// likely a percentage typed where basis points were meant.
export const REFERRAL_COMMISSION_BPS_MAX = 10000

export type ReferralCommissionValues = {
  referralCommissionBps: number
}

export type ReferralCommissionParseResult =
  | { ok: true; values: ReferralCommissionValues }
  | { ok: false; error: string }

/**
 * Validate the tenant-default referral commission rate from a raw request body.
 * Pure — no I/O. The single source of validation truth shared by the API route
 * and its tests.
 *
 * 0 is accepted and means "commission off". That is a legitimate setting, but a
 * silent one: agents with no per-agent override inherit it and earn nothing,
 * which is how the ledger sat empty from 2026-07-11 to 2026-08-06. The route's
 * UI copy — not this parser — is responsible for saying so out loud.
 */
export function parseReferralCommissionInput(body: unknown): ReferralCommissionParseResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Invalid request body." }
  }
  const b = body as Record<string, unknown>

  const referralCommissionBps = b.referralCommissionBps
  // Number.isInteger is false for NaN, Infinity and non-numbers, so it covers
  // the fractional, string and missing-key cases in one check.
  if (!Number.isInteger(referralCommissionBps)) {
    return { ok: false, error: "referralCommissionBps must be an integer." }
  }
  const bps = referralCommissionBps as number
  if (bps < 0 || bps > REFERRAL_COMMISSION_BPS_MAX) {
    return { ok: false, error: `referralCommissionBps must be between 0 and ${REFERRAL_COMMISSION_BPS_MAX}.` }
  }

  return { ok: true, values: { referralCommissionBps: bps } }
}
