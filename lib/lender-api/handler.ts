import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { runWithTenant, withoutTenantScope } from "@/lib/tenant-scope"
import { createLocalRateLimiter, createRateLimiter, recordedCallerIp } from "@/lib/rate-limit"
import { apiKeyMatches, apiKeyPrefix, apiKeyState, bearerToken, keyIssuerStillAuthorised } from "@/lib/lender-api/keys"
import { hasScope, type ApiScope } from "@/lib/lender-api/scopes"
import { apiError } from "@/lib/lender-api/api-error"
import { sourceAddressAllowed } from "@/lib/lender-api/ip-restriction"
import { authenticateAccessToken, looksLikeAccessToken } from "@/lib/lender-api/oauth/authenticate"
import { limiterAddress } from "@/lib/limiter-address"

/**
 * The one entry point for /api/v1 routes. Every call:
 *   1. must carry `Authorization: Bearer cfk_…` naming an active, unexpired key
 *      of an ACTIVE tenant, whose creator is still an active ADMIN or above,
 *      or an OAuth2 access token (lib/lender-api/oauth) of a client that is
 *      active under the same rules; both are the same kind of caller below,
 *   2. must come from the credential's source-address allowlist when it has one,
 *      and hold the route's scope,
 *   3. is rate limited per KEY (any request naming a real key counts, refused
 *      or not), so one key's traffic never spends another's allowance,
 *   4. runs inside runWithTenant(key.tenantId): the tenant comes from the key
 *      row only, never from a header or the host, and the Prisma tenant-scope
 *      extension confines every query to it,
 *   5. is written to ApiRequestLog, except that rows naming no key and 429s are
 *      sampled (UNATTRIBUTED_LOG_SAMPLE per process) so a flood of junk keys
 *      cannot fill the table; what is dropped is counted in the server log.
 * Failed authentication is also counted, per caller address when it is known
 * (TRUSTED_PROXY), else in one coarse global bucket: over the limit, failures
 * answer 429 instead of 401. Neither is consulted for a valid key, so junk
 * traffic from anywhere can never lock a real integration out. Each kind of
 * bucket has its own store (createRateLimiter), so a flood of distinct
 * addresses can never evict a key's bucket and lift its limit.
 */

/** What authenticated the call: an API key row or an OAuth client row. */
export type CredentialKind = "api_key" | "oauth_client"

export interface ApiCaller {
  /** The id of the credential row (ApiKey, or OauthClient when `kind` says so). */
  keyId: string
  kind: CredentialKind
  tenantId: string
  scopes: string[]
  createdById: string
}

export const API_KEY_RATE_LIMIT = { limit: 120, windowMs: 60_000 }
export const API_FAILED_AUTH_IP_LIMIT = { limit: 30, windowMs: 60_000 }
export const API_FAILED_AUTH_GLOBAL_LIMIT = { limit: 300, windowMs: 60_000 }
export const UNATTRIBUTED_LOG_SAMPLE = { limit: 10, windowMs: 60_000 }

// Key buckets are bounded by the ApiKey rows that exist (a bucket is made only
// for a real key), so their store is sized well past that and never shared.
// Namespaces are in the shared store's keys (lib/rate-limit.ts): never rename one.
const keyLimiter = createRateLimiter(200_000, "lender-api:key")
const failedAuthByAddress = createRateLimiter(10_000, "lender-api:failed-auth:address")
// Per pod: one key, so in the shared store every failed request would queue on a single row lock.
const failedAuthGlobal = createLocalRateLimiter(1)
// Per process: it only decides how many log rows to write.
const logSampler = createLocalRateLimiter(1)
const LAST_USED_RESOLUTION_MS = 60_000

export { apiError }

export type AuthOutcome =
  | { ok: true; caller: ApiCaller; lastUsedAt: Date | null; ipAllowlist: string[] }
  | { ok: false; response: NextResponse; tenantId: string | null; keyId: string | null; kind: CredentialKind }

export async function authenticateApiKey(req: Request, now: Date = new Date()): Promise<AuthOutcome> {
  const fail = (status: number, code: string, message: string, tenantId: string | null = null, keyId: string | null = null): AuthOutcome =>
    ({ ok: false, response: apiError(status, code, message, status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined), tenantId, keyId, kind: "api_key" })

  const token = bearerToken(req.headers.get("authorization"))
  if (!token) return fail(401, "missing_api_key", "Send an API key or an OAuth access token as `Authorization: Bearer <credential>`.")
  if (looksLikeAccessToken(token)) return authenticateAccessToken(req, token, now)
  const prefix = apiKeyPrefix(token)
  if (!prefix) return fail(401, "invalid_api_key", "The API key is not valid.")

  // The tenant is not known until the key is found, so this one lookup runs
  // outside the tenant scope; it is by the key's unique prefix only.
  // Awaited INSIDE the frame: a PrismaPromise is lazy and would otherwise run after it.
  const row = await withoutTenantScope(async () => await prisma.apiKey.findUnique({
    where: { prefix },
    select: {
      id: true, tenantId: true, keyHash: true, scopes: true, createdById: true, ipAllowlist: true,
      expiresAt: true, revokedAt: true, lastUsedAt: true,
      tenant: { select: { status: true } },
      createdBy: { select: { active: true, role: true } },
    },
  }))
  if (!row || !apiKeyMatches(token, row.keyHash)) return fail(401, "invalid_api_key", "The API key is not valid.")

  const state = apiKeyState(row, now)
  if (state !== "active") return fail(401, `api_key_${state}`, `The API key is ${state}.`, row.tenantId, row.id)
  // A key is a standing grant by the admin who made it: once they are
  // deactivated or no longer an ADMIN, it stops working (Settings shows it as suspended).
  if (!keyIssuerStillAuthorised(row.createdBy)) {
    return fail(401, "api_key_suspended", "The API key's creator is no longer an active admin. Create a new key.", row.tenantId, row.id)
  }
  if (row.tenant.status !== "ACTIVE") return fail(403, "tenant_inactive", "This lender is not active.", row.tenantId, row.id)

  return {
    ok: true,
    caller: { keyId: row.id, kind: "api_key", tenantId: row.tenantId, scopes: row.scopes, createdById: row.createdById },
    lastUsedAt: row.lastUsedAt,
    ipAllowlist: row.ipAllowlist ?? [],
  }
}

async function touchLastUsed(caller: ApiCaller, lastUsedAt: Date | null, now: Date): Promise<void> {
  if (lastUsedAt && now.getTime() - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) return
  const where = { id: caller.keyId, tenantId: caller.tenantId }
  if (caller.kind === "oauth_client") await prisma.oauthClient.updateMany({ where, data: { lastUsedAt: now } })
  else await prisma.apiKey.updateMany({ where, data: { lastUsedAt: now } })
}

let suppressedLogRows = 0

/** Whether to write this row: always when it names a key and is not a 429, else sampled. */
function shouldLog(keyId: string | null, status: number): boolean {
  if (keyId !== null && status !== 429) return true
  if (logSampler("unattributed", UNATTRIBUTED_LOG_SAMPLE).allowed) return true
  suppressedLogRows++
  return false
}

export async function logApiRequest(
  req: Request,
  entry: { tenantId: string | null; keyId: string | null; kind: CredentialKind; status: number; startedAt: number },
) {
  if (!shouldLog(entry.keyId, entry.status)) return
  if (suppressedLogRows > 0) {
    console.warn(`[lender-api] ${suppressedLogRows} unattributed or rate-limited request(s) not written to ApiRequestLog (sampled)`)
    suppressedLogRows = 0
  }
  try {
    await prisma.apiRequestLog.create({
      data: {
        tenantId: entry.tenantId,
        apiKeyId: entry.kind === "api_key" ? entry.keyId : null,
        oauthClientId: entry.kind === "oauth_client" ? entry.keyId : null,
        method: req.method,
        path: new URL(req.url).pathname.slice(0, 300),
        status: entry.status,
        ipAddress: recordedCallerIp(req),
        durationMs: Math.max(0, Date.now() - entry.startedAt),
      },
    })
  } catch (error) {
    // The response has been decided; a lost log row must still be visible.
    console.error("[lender-api] failed to write ApiRequestLog", { keyId: entry.keyId, status: entry.status }, error)
  }
}

function tooMany(retryAfterSeconds: number, message: string): NextResponse {
  return apiError(429, "rate_limited", message, { "Retry-After": String(retryAfterSeconds) })
}

export async function withApiKey(
  req: Request,
  scope: ApiScope,
  handler: (caller: ApiCaller) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now()
  let tenantId: string | null = null
  let keyId: string | null = null
  let kind: CredentialKind = "api_key"
  let response: Response
  try {
    const auth = await authenticateApiKey(req)
    tenantId = auth.ok ? auth.caller.tenantId : auth.tenantId
    keyId = auth.ok ? auth.caller.keyId : auth.keyId
    kind = auth.ok ? auth.caller.kind : auth.kind
    // Per credential (key or OAuth client), for every request that names a real one (refused ones too).
    const keyLimit = keyId ? await keyLimiter(kind === "oauth_client" ? `oauth:${keyId}` : keyId, API_KEY_RATE_LIMIT) : null
    if (keyLimit && !keyLimit.allowed) {
      response = tooMany(keyLimit.retryAfterSeconds, kind === "oauth_client" ? "Too many requests for this OAuth client." : "Too many requests for this API key.")
    } else if (!auth.ok) {
      const ip = recordedCallerIp(req)
      const failLimit = ip ? await failedAuthByAddress(limiterAddress(ip), API_FAILED_AUTH_IP_LIMIT) : failedAuthGlobal("unknown-address", API_FAILED_AUTH_GLOBAL_LIMIT)
      response = failLimit.allowed ? auth.response : tooMany(failLimit.retryAfterSeconds, "Too many failed requests.")
    } else if (!sourceAddressAllowed(req, auth.ipAllowlist)) {
      // The key (or client) is real and valid but not from here: its allowlist, on the TRUSTED_PROXY-aware caller address.
      response = apiError(403, "ip_not_allowed", `This ${kind === "oauth_client" ? "OAuth client" : "API key"} may not be used from this address.`)
    } else if (!hasScope(auth.caller.scopes, scope)) {
      response = apiError(403, "insufficient_scope", `This ${kind === "oauth_client" ? "access token" : "API key"} does not have the ${scope} scope.`)
    } else {
      const { caller } = auth
      response = await runWithTenant(caller.tenantId, async () => {
        await touchLastUsed(caller, auth.lastUsedAt, new Date())
        return handler(caller)
      })
      response.headers.set("X-RateLimit-Limit", String(API_KEY_RATE_LIMIT.limit))
      response.headers.set("X-RateLimit-Remaining", String(keyLimit?.remaining ?? 0))
    }
  } catch (error) {
    console.error("[lender-api] request failed", { path: new URL(req.url).pathname, keyId }, error)
    response = apiError(500, "internal_error", "The request failed.")
  }
  response.headers.set("Cache-Control", "no-store")
  await logApiRequest(req, { tenantId, keyId, kind, status: response.status, startedAt })
  return response
}
