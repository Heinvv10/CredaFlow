import { NextResponse } from "next/server"

/**
 * Forced TOTP enrolment (TenantConfig.requireStaffTotp). A staff session whose
 * sign-in found the lender requiring 2FA and the user with none carries
 * `totpEnrolmentRequired`; proxy.ts then lets it reach only the enrolment page
 * and the two enrolment API calls (generate a secret, verify it).
 */
export const ENROLMENT_PAGE = "/settings/security"
const ENROLMENT_API = "/api/settings/totp"

export const enrolmentRequiredResponse = () =>
  NextResponse.json({ error: "Two-factor enrolment required", code: "totp_enrolment_required" }, { status: 403 })

/** Null when the request may proceed; otherwise the response that refuses it. */
export function enrolmentGate(req: { nextUrl: URL; url: string; method: string }): Response | null {
  const path = req.nextUrl.pathname.replace(/\/+$/, "") || "/"
  if (path.startsWith("/api/")) {
    const allowed = path === ENROLMENT_API && (req.method === "GET" || req.method === "POST")
    return allowed ? null : enrolmentRequiredResponse()
  }
  return path === ENROLMENT_PAGE ? null : NextResponse.redirect(new URL(ENROLMENT_PAGE, req.url))
}
