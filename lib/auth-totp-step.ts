import { claimTotpCounter } from "./totp-claim"

/**
 * The TOTP step of a sign-in (lib/auth.ts), shared by lender staff and
 * operator staff so there is one place a code is checked. Fail-closed on an
 * inconsistent row (2FA flagged on with no secret). The caller decides what
 * each outcome costs (audit rows, which error the form sees).
 */
export type SignInTotpOutcome =
  | { kind: "verified" }
  | { kind: "not_enrolled" }
  /** Enrolled and no code was given: the form asks for one. */
  | { kind: "required" }
  | { kind: "misconfigured" }
  | { kind: "invalid" }
  /** A valid code whose counter was already claimed. */
  | { kind: "replayed" }

export async function signInTotpOutcome(
  user: { id: string; totpEnabled: boolean; totpSecret: string | null },
  rawCode: unknown,
): Promise<SignInTotpOutcome> {
  if (!user.totpEnabled && !user.totpSecret) return { kind: "not_enrolled" }
  if (!user.totpSecret) return { kind: "misconfigured" }
  const code = typeof rawCode === "string" ? rawCode.trim() : ""
  if (!code) return { kind: "required" }
  const { verifyTotpCode } = await import("./totp")
  const matchedCounter = verifyTotpCode(code, user.totpSecret)
  if (matchedCounter === null) return { kind: "invalid" }
  return (await claimTotpCounter(user.id, matchedCounter)) ? { kind: "verified" } : { kind: "replayed" }
}
