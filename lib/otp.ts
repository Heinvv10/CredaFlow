import { randomInt } from "crypto"

/**
 * Cryptographically-secure 6-digit numeric OTP.
 *
 * Uses `crypto.randomInt` (a CSPRNG) rather than `Math.random()`, whose V8
 * PRNG state is recoverable from a handful of observed outputs — unacceptable
 * for auth codes, where an attacker able to observe their own codes could then
 * predict another user's. `randomInt(100000, 1000000)` is uniform over
 * [100000, 999999], so the result is always exactly 6 digits.
 */
export function generateOtp(): string {
  return randomInt(100000, 1000000).toString()
}
