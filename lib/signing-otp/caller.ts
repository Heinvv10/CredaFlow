import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { hasMinRole } from "@/lib/auth-guards"
import { enrolmentRequiredResponse } from "@/lib/proxy/totp-enrolment"

/**
 * Who may drive a signing OTP: the borrower in their portal session, or a
 * credit officer witnessing a branch signing. Same split as the signing
 * routes themselves (agreement/sign: CLIENT ⇒ portal, staff ⇒ branch).
 */
export type SigningOtpCaller =
  | { kind: "client"; clientId: string; email: string; method: "portal" }
  | { kind: "staff"; userId: string; email: string; method: "branch" }

export async function signingOtpCaller(): Promise<{ caller: SigningOtpCaller } | { error: NextResponse }> {
  const session = await auth()
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  const user = session.user
  if (user.role === "CLIENT") {
    return { caller: { kind: "client", clientId: user.id, email: user.email, method: "portal" } }
  }
  if (user.totpEnrolmentRequired === true) return { error: enrolmentRequiredResponse() }
  if (!hasMinRole(user.role, "CREDIT_OFFICER")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { caller: { kind: "staff", userId: user.id, email: user.email, method: "branch" } }
}
