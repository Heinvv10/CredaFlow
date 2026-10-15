/**
 * When a signature needs a verified OTP, and what a signing route answers
 * when it is missing.
 *
 * requireSigningOtp (default on) covers portal signing: the borrower alone,
 * on their own device, where the session is the only other proof of who is
 * signing. Branch signing has a staff witness who attests to the borrower's
 * presence, so it is exempt while signingOtpBranchExempt is on (the default);
 * switching that off makes the witness obtain a code from the borrower too.
 * A returned wet-ink packet is a paper signature and never needs one.
 */
import { NextResponse } from "next/server"
import { getPortalPolicy, type PortalPolicy } from "@/lib/portal/portal-policy"
import { SIGNING_OTP_REFUSAL_MESSAGES, type ConsumeRefusal } from "./challenge"

export type SigningMethod = "portal" | "branch"

export function signingOtpRequired(
  policy: Pick<PortalPolicy, "requireSigningOtp" | "signingOtpBranchExempt">,
  method: SigningMethod,
): boolean {
  if (!policy.requireSigningOtp) return false
  return method === "portal" || !policy.signingOtpBranchExempt
}

export async function isSigningOtpRequired(tenantId: string, method: SigningMethod): Promise<boolean> {
  return signingOtpRequired(await getPortalPolicy(tenantId), method)
}

/** Reads the optional challenge id a signing request carries. */
export function signingOtpChallengeIdFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const value = (body as { signingOtpChallengeId?: unknown }).signingOtpChallengeId
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function signingOtpRefusal(reason: ConsumeRefusal | "required"): NextResponse {
  return NextResponse.json(
    { error: SIGNING_OTP_REFUSAL_MESSAGES[reason], signingOtp: reason },
    { status: reason === "document_changed" ? 409 : 403 },
  )
}
