import { CredentialsSignin } from "next-auth"
import { prisma } from "@/lib/prisma"
import { callerIp } from "@/lib/rate-limit"
import { dealerAppHost, normaliseHost, operatorAppHost } from "@/lib/config/deployment-urls"
import { staffAccessSignInCode } from "@/lib/security/staff-access-messages"
import { authorizeSso } from "./authorize"
import { ssoTicketFromCookieHeader } from "./cookies"

/**
 * NextAuth's "sso" credentials provider: the browser arrives from the SSO
 * callback holding a ticket cookie (HttpOnly, so no script reads it) and posts
 * only the optional authenticator code. Errors use the same codes the password
 * form already understands.
 */

class SsoCodeRequired extends CredentialsSignin { code = "totp_required" }
class SsoCodeInvalid extends CredentialsSignin { code = "totp_invalid" }
class SsoRateLimited extends CredentialsSignin { code = "rate_limited" }
class SsoRefused extends CredentialsSignin { code = "sso_refused" }
class SsoAccessRefused extends CredentialsSignin {
  constructor(reason: Parameters<typeof staffAccessSignInCode>[0]) { super(); this.code = staffAccessSignInCode(reason) }
}

/** Staff sign-in belongs to the staff host: not the client portal, operator console or dealer portal hosts. */
function onStaffHost(request: Request): boolean {
  if (process.env.APP_MODE === "client") return false
  const host = normaliseHost(request.headers.get("host") ?? "")
  return host !== operatorAppHost() && host !== dealerAppHost()
}

export async function authorizeSsoCredentials(credentials: Partial<Record<string, unknown>> | undefined, request: Request) {
  const ip = callerIp(request)
  const userAgent = request.headers.get("user-agent")
  const ticket = ssoTicketFromCookieHeader(request.headers.get("cookie"))
  const recordFailure = (reason: string, email?: string) =>
    prisma.failedLoginAttempt.create({ data: { email: email ?? "sso", ip, userAgent, reason } })
      .catch((err: unknown) => { console.error("[sso] failedLoginAttempt insert failed:", err) })
  if (!ticket || !onStaffHost(request)) {
    await recordFailure(ticket ? "wrong_audience" : "sso_ticket_missing")
    throw new SsoRefused()
  }
  const result = await authorizeSso({ ticket, code: credentials?.code, ip, userAgent, recordFailure })
  if (result.ok) return result.user
  if (result.error === "totp_required") throw new SsoCodeRequired()
  if (result.error === "totp_invalid") throw new SsoCodeInvalid()
  if (result.error === "rate_limited") throw new SsoRateLimited()
  if (result.error === "access_refused") throw new SsoAccessRefused(result.reason)
  throw new SsoRefused()
}
