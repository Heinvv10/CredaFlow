import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getTenantFromRequest } from "@/lib/tenant"
import { runWithTenant } from "@/lib/tenant-scope"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { safePortalPath } from "@/lib/portal-urls"
import { isPortalEnabled } from "@/lib/portal/portal-policy"

export const dynamic = "force-dynamic"

// Smart entry for email CTAs: check account state at CLICK time and route to the
// correct place, rather than baking login-vs-register at send time (which goes
// stale if the customer registers between the email going out and clicking it).

const DEFAULT_DESTINATION = "/portal/applications"

function loginPath(next: string | null): string {
  return `/portal/login?callbackUrl=${encodeURIComponent(next ?? DEFAULT_DESTINATION)}`
}

// `next` is carried through registration too, not just login: an unregistered
// customer following a deep link (e.g. "sign your agreement") would otherwise
// activate their account and land on the applications list, having lost the
// destination that brought them here.
function registerPath(email: string, reference: string, next: string | null): string {
  const params = new URLSearchParams()
  if (email) params.set("email", email)
  if (reference) params.set("reference", reference)
  if (next) params.set("next", next)
  const qs = params.toString()
  return `/portal/register${qs ? `?${qs}` : ""}`
}

// A route handler's `req.url` is the internal 0.0.0.0 bind, so building an
// absolute redirect from it leaks the internal host behind nginx. A RELATIVE
// Location is resolved by the browser against the public URL it requested.
// (feedback_route_handler_relative_redirect)
function seeOther(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } })
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const email = (url.searchParams.get("email") ?? "").toLowerCase().trim()
  const reference = (url.searchParams.get("reference") ?? "").trim()
  // Reaches a redirect Location — allowlisted, never echoed raw.
  const next = safePortalPath(url.searchParams.get("next"))

  // Everything we can't positively match falls through to register. register
  // itself needs email + ID number and is rate-limited, so this endpoint never
  // becomes a bulk "does this email have an account" oracle: without a valid
  // (email, reference) pair, the answer is always the same (→ register).
  const gate = await checkRateLimit(`portal:continue:${callerIp(req)}`, { limit: 30, windowMs: 10 * 60 * 1000 })
  if (!email || !reference || !gate.allowed) return seeOther(registerPath(email, reference, next))

  const tenant = await getTenantFromRequest(req)
  if (!tenant) return seeOther(registerPath(email, reference, next))
  // Portal off: the sign-in page explains it. A lender-wide answer, asked
  // before any account lookup, so it says nothing about the email.
  if (!(await isPortalEnabled(tenant.id))) return seeOther("/portal/login")

  const client = await runWithTenant(tenant.id, () =>
    prisma.client.findFirst({
      where: {
        tenantId: tenant.id,
        email,
        // The emailed reference is either the client's own reference or one of
        // its application references — require it to match so a bare email can't
        // learn account existence.
        OR: [{ reference }, { applications: { some: { reference } } }],
      },
      select: { portalPassword: true },
    })
  )

  // Registered (password set) → login. Applied-but-not-registered, or the
  // (email, reference) pair doesn't match a real application → register, prefilled.
  return seeOther(client?.portalPassword ? loginPath(next) : registerPath(email, reference, next))
}
