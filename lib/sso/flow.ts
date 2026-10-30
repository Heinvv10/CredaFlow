import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getTenantFromRequest } from "@/lib/tenant"
import { runWithTenant } from "@/lib/tenant-scope"
import { callerIp, checkRateLimit } from "@/lib/rate-limit"
import { requireAppBaseUrl } from "@/lib/config/deployment-urls"
import { safeInternalPath } from "@/lib/safe-path"
import { getEnabledConnection, type LoadedConnection } from "./connection"
import { cookieOptions, flowCookieName, ssoFlowFromCookieHeader, ticketCookieName } from "./cookies"
import { resolveStaffUser, type IdpIdentity } from "./identity"
import { beginOidc, completeOidc, type OidcOptions } from "./oidc"
import { beginSaml, completeSaml, samlServiceProviderMetadata } from "./saml"
import { mintTicket, readState, STATE_TTL_SECONDS, TICKET_TTL_SECONDS, type SsoFlowState } from "./tokens"
import { limiterAddress } from "@/lib/limiter-address"

/**
 * The browser-facing half of SSO sign-in, behind three thin routes under
 * app/api/auth/sso/: start (leave for the provider), the OIDC callback and the
 * SAML ACS (come back with a verified identity). On success the browser leaves
 * holding a single-use ticket cookie and lands on /login?sso=1, whose form
 * trades it for a session through NextAuth (lib/sso/provider.ts) and asks for
 * an authenticator code when one is due. On any failure: the flow cookie is
 * cleared, the reason is recorded, and the browser is told only "sso_refused".
 */

const START_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 } as const
const RETURN_LIMIT = { limit: 60, windowMs: 15 * 60 * 1000 } as const
const MAX_SAML_RESPONSE_CHARS = 400_000
const OIDC_CALLBACK_PATH = "/api/auth/sso/oidc/callback"
const SAML_ACS_PATH = "/api/auth/sso/saml/acs"

const appUrl = (path: string) => `${requireAppBaseUrl()}${path}`

function toLogin(query: Record<string, string>, clearFlow: boolean): NextResponse {
  const url = new URL("/login", requireAppBaseUrl())
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const res = NextResponse.redirect(url, 303)
  if (clearFlow) res.cookies.set(flowCookieName(), "", { ...cookieOptions(0, true), maxAge: 0 })
  return res
}

async function refuse(req: Request, reason: string, cause?: unknown): Promise<NextResponse> {
  const ip = callerIp(req)
  console.warn("[sso] sign-in refused:", reason, cause instanceof Error ? cause.message : "")
  await prisma.failedLoginAttempt.create({ data: { email: "sso", ip, userAgent: req.headers.get("user-agent"), reason: `sso_${reason}` } })
    .catch((err: unknown) => { console.error("[sso] failedLoginAttempt insert failed:", err) })
  return toLogin({ sso_error: "sso_refused" }, true)
}

type Ready = { tenantId: string; conn: LoadedConnection }

/** The lender behind this host and its enabled connection, or the refusing response. */
async function ready(req: Request, limit: typeof START_LIMIT | typeof RETURN_LIMIT, bucket: string): Promise<Ready | NextResponse> {
  // Staff hosts only; the client portal host has no staff sign-in (proxy.ts also 404s these paths there).
  if (process.env.APP_MODE === "client") return new NextResponse("Not found", { status: 404 })
  if (!(await checkRateLimit(`sso:${bucket}:${limiterAddress(callerIp(req))}`, limit)).allowed) return toLogin({ sso_error: "rate_limited" }, false)
  const tenant = await getTenantFromRequest(req)
  if (!tenant) return refuse(req, "no_tenant")
  const conn = await runWithTenant(tenant.id, () => getEnabledConnection(tenant.id))
  if (!conn) return refuse(req, "not_enabled")
  return { tenantId: tenant.id, conn }
}

export async function handleSsoStart(req: Request, opts: OidcOptions = {}): Promise<Response> {
  const r = await ready(req, START_LIMIT, "start")
  if (r instanceof NextResponse) return r
  const returnTo = safeInternalPath(new URL(req.url).searchParams.get("callbackUrl")) ?? "/dashboard"
  try {
    const begun = r.conn.protocol === "OIDC"
      ? await beginOidc(r.conn, { redirectUri: appUrl(OIDC_CALLBACK_PATH), returnTo }, opts)
      : await beginSaml(r.conn, { acsUrl: appUrl(SAML_ACS_PATH), returnTo })
    const res = NextResponse.redirect(begun.url, 303)
    res.cookies.set(flowCookieName(), begun.stateToken, cookieOptions(STATE_TTL_SECONDS, r.conn.protocol === "SAML"))
    return res
  } catch (error) {
    return refuse(req, "begin_failed", error)
  }
}

async function flowFor(req: Request, tenantId: string): Promise<SsoFlowState | null> {
  const flow = await readState(ssoFlowFromCookieHeader(req.headers.get("cookie")) ?? "")
  return flow && flow.tenantId === tenantId ? flow : null
}

/** Map the verified identity to a staff user and send the browser on with a ticket. */
async function finish(req: Request, r: Ready, flow: SsoFlowState, identity: IdpIdentity): Promise<Response> {
  const resolved = await resolveStaffUser(identity, r.conn)
  if (!resolved.ok) return refuse(req, resolved.reason)
  const ticket = await mintTicket({ userId: resolved.userId, tenantId: r.tenantId, mfaReported: identity.mfaProven, role: resolved.role })
  const res = toLogin({ sso: "1", callbackUrl: flow.returnTo }, true)
  res.cookies.set(ticketCookieName(), ticket, cookieOptions(TICKET_TTL_SECONDS, false))
  return res
}

export async function handleOidcCallback(req: Request, opts: OidcOptions = {}): Promise<Response> {
  const r = await ready(req, RETURN_LIMIT, "return")
  if (r instanceof NextResponse) return r
  const callbackUrl = new URL(req.url)
  const flow = await flowFor(req, r.tenantId)
  if (!flow || r.conn.protocol !== "OIDC") return refuse(req, "no_flow")
  if (callbackUrl.searchParams.has("error")) return refuse(req, "provider_error")
  try {
    // The provider's redirect target is fixed; whatever origin the proxy shows us, the code is exchanged for OUR callback.
    const expected = new URL(OIDC_CALLBACK_PATH, requireAppBaseUrl())
    expected.search = callbackUrl.search
    const identity = await completeOidc(r.conn, { callbackUrl: expected, flow }, opts)
    return await finish(req, r, flow, identity)
  } catch (error) {
    return refuse(req, (error as { code?: string }).code ?? "oidc_failed", error)
  }
}

export async function handleSamlAcs(req: Request): Promise<Response> {
  const r = await ready(req, RETURN_LIMIT, "return")
  if (r instanceof NextResponse) return r
  const flow = await flowFor(req, r.tenantId)
  if (!flow || r.conn.protocol !== "SAML") return refuse(req, "no_flow")
  try {
    const form = await req.formData()
    const samlResponse = form.get("SAMLResponse")
    const relayState = form.get("RelayState")
    if (typeof samlResponse !== "string" || samlResponse.length === 0 || samlResponse.length > MAX_SAML_RESPONSE_CHARS) return await refuse(req, "bad_response")
    const identity = await completeSaml(r.conn, {
      acsUrl: appUrl(SAML_ACS_PATH), samlResponse, relayState: typeof relayState === "string" ? relayState : null, flow,
    })
    return await finish(req, r, flow, identity)
  } catch (error) {
    return refuse(req, (error as { code?: string }).code ?? "saml_failed", error)
  }
}

/** GET /api/auth/sso/saml/metadata: the SP metadata XML, only while this lender has SAML switched on. */
export async function handleSamlMetadata(req: Request): Promise<Response> {
  if (process.env.APP_MODE === "client") return new NextResponse("Not found", { status: 404 })
  const tenant = await getTenantFromRequest(req)
  const conn = tenant ? await runWithTenant(tenant.id, () => getEnabledConnection(tenant.id)) : null
  if (!conn || conn.protocol !== "SAML") return new NextResponse("Not found", { status: 404 })
  return new NextResponse(samlServiceProviderMetadata(conn, appUrl(SAML_ACS_PATH)), {
    headers: { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "no-store" },
  })
}
