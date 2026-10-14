/**
 * Operator staff sign-in and session revalidation (lib/auth.ts calls these).
 *
 * An operator user signs in only on the operator host (lib/auth.ts checks the
 * host before calling here), must be active, hold an operator role, be bound
 * to an operator and to no tenant (the database's User_operator_binding_check
 * says the same). 2FA is mandatory and no lender policy applies: a user with
 * no TOTP gets a session held at enrolment (lib/proxy/operator-host.ts), and
 * nothing in the console accepts a session whose sign-in did not verify a code
 * (lib/operator/console-auth.ts).
 */
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { signInTotpOutcome } from "@/lib/auth-totp-step"
import { isOperatorRole, type OperatorRole } from "./roles"

export type OperatorSignInUser = {
  id: string
  email: string
  name: string | null
  role: OperatorRole
  tenantId: null
  operatorId: string
  tokenVersion: number
  totpVerified: boolean
  totpEnrolmentRequired: boolean
}

export type OperatorSignInResult =
  | { ok: true; user: OperatorSignInUser }
  /** Wrong password, inactive, or not an operator user: "Invalid email or password". */
  | { ok: false; error: "refused" }
  | { ok: false; error: "wrong_audience" | "totp_required" | "totp_invalid" }

export async function authorizeOperator(input: {
  email: string
  password: string
  code: unknown
  /** Records a FailedLoginAttempt row (lib/auth.ts). */
  recordFailure: (reason: string) => Promise<unknown>
  /** Burns the bcrypt time of a real comparison when there is no row. */
  equalizeTiming: (candidate: string) => Promise<void>
}): Promise<OperatorSignInResult> {
  const { email, password, recordFailure } = input
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    await input.equalizeTiming(password)
    await recordFailure("wrong_audience")
    return { ok: false, error: "wrong_audience" }
  }
  // bcrypt first, whatever the row says, so timing does not tell an inactive
  // or lender account from an active operator one.
  const passwordMatch = await bcrypt.compare(password, user.password)
  const isOperator = isOperatorRole(user.role) && !!user.operatorId && !user.tenantId
  if (!passwordMatch || !user.active || !isOperator) {
    await recordFailure(!passwordMatch ? "wrong_password" : !user.active ? "operator_inactive" : "not_operator")
    return { ok: false, error: "refused" }
  }

  const totp = await signInTotpOutcome(user, input.code)
  switch (totp.kind) {
    case "required":
      return { ok: false, error: "totp_required" }
    case "misconfigured":
    case "invalid":
    case "replayed":
      await recordFailure(totp.kind === "misconfigured" ? "totp_misconfigured" : totp.kind === "invalid" ? "totp_invalid" : "totp_replay")
      return { ok: false, error: "totp_invalid" }
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    .catch((err: unknown) => { console.error("[auth] operator lastLoginAt update failed:", err) })
  return {
    ok: true,
    user: {
      id: user.id, email: user.email, name: user.name,
      role: user.role as OperatorRole, tenantId: null, operatorId: user.operatorId as string,
      tokenVersion: user.tokenVersion,
      totpVerified: totp.kind === "verified",
      // Not enrolled: the session reaches the enrolment page only.
      totpEnrolmentRequired: totp.kind === "not_enrolled",
    },
  }
}

/**
 * The operator user as the database has it now, for every request's JWT
 * revalidation. null → sign out (deactivated, role or binding changed,
 * tokenVersion bumped); "error" → transient DB failure (keep the token).
 */
export async function revalidateOperatorPrincipal(
  userId: string,
  tokenVersion: number,
): Promise<{ role: OperatorRole; operatorId: string } | null | "error"> {
  let fresh: { active: boolean; role: string; operatorId: string | null; tenantId: string | null; tokenVersion: number } | null
  try {
    fresh = await prisma.user.findUnique({
      where: { id: userId },
      select: { active: true, role: true, operatorId: true, tenantId: true, tokenVersion: true },
    })
  } catch (err) {
    console.error("[auth] revalidateOperatorPrincipal DB error — retaining existing token:", err)
    return "error"
  }
  if (!fresh || !fresh.active || !isOperatorRole(fresh.role) || !fresh.operatorId || fresh.tenantId) return null
  if (fresh.tokenVersion !== tokenVersion) return null
  return { role: fresh.role, operatorId: fresh.operatorId }
}
