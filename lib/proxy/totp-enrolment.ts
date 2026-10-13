import { NextResponse } from "next/server"

/**
 * Forced TOTP enrolment (TenantConfig.requireStaffTotp). A staff session whose
 * sign-in found the lender requiring 2FA and the user with none carries
 * `totpEnrolmentRequired`; proxy.ts then lets it read only the enrolment page
 * and call only the two enrolment APIs (generate a secret, verify it).
 */
export const ENROLMENT_PAGE = "/settings/security"
const ENROLMENT_API = "/api/settings/totp"

export const enrolmentRequiredResponse = () =>
  NextResponse.json({ error: "Two-factor enrolment required", code: "totp_enrolment_required" }, { status: 403 })

/**
 * True for a staff session held at enrolment. A token with no claim at all
 * predates the policy and is held too; a CLIENT session is never.
 */
export function isHeldAtEnrolment(
  auth: { user?: { role?: string | null; totpEnrolmentRequired?: boolean } | null } | null | undefined,
): boolean {
  const user = auth?.user
  return !!user && user.role !== "CLIENT" && user.totpEnrolmentRequired !== false
}

/**
 * Null when a held session's request may proceed; otherwise the response that
 * refuses it.
 *
 * Pages: GET and HEAD only. A server action is a POST to a page URL: with the
 * `next-action` header (JS), or as a multipart/urlencoded form carrying a
 * `$ACTION_ID_<id>` field (progressive enhancement, no header). The refusal
 * keys off the method, never the content type or body, and covers public
 * paths too. Beyond that, only ENROLMENT_PAGE is readable; any other page
 * redirects to it.
 * APIs: only GET and POST of the enrolment API (public API routes, which
 * answer before this gate, are untouched).
 */
export function enrolmentGate(
  req: { nextUrl: URL; url: string; method: string; headers: Headers },
  isPublicRoute: boolean,
): Response | null {
  const path = req.nextUrl.pathname.replace(/\/+$/, "") || "/"
  const isApi = path.startsWith("/api/")
  if (req.headers.has("next-action")) return enrolmentRequiredResponse()
  if (!isApi && req.method !== "GET" && req.method !== "HEAD") return enrolmentRequiredResponse()
  if (isPublicRoute) return null
  if (isApi) {
    const allowed = path === ENROLMENT_API && (req.method === "GET" || req.method === "POST")
    return allowed ? null : enrolmentRequiredResponse()
  }
  return path === ENROLMENT_PAGE ? null : NextResponse.redirect(new URL(ENROLMENT_PAGE, req.url))
}
