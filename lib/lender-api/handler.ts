import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { runWithTenant, withoutTenantScope } from "@/lib/tenant-scope"
import { callerIp, checkRateLimit, recordedCallerIp } from "@/lib/rate-limit"
import { apiKeyMatches, apiKeyPrefix, apiKeyState, bearerToken } from "@/lib/lender-api/keys"
import { hasScope, type ApiScope } from "@/lib/lender-api/scopes"

/**
 * The one entry point for /api/v1 routes. Every call:
 *   1. is rate limited per caller address (bounds unauthenticated floods),
 *   2. must carry `Authorization: Bearer cfk_…` naming an active, unexpired key
 *      of an ACTIVE tenant,
 *   3. must hold the route's scope,
 *   4. is rate limited per key,
 *   5. runs inside runWithTenant(key.tenantId): the tenant comes from the key
 *      row only, never from a header or the host, and the Prisma tenant-scope
 *      extension confines every query to it,
 *   6. is written to ApiRequestLog with its status, whatever the outcome.
 */

export interface ApiCaller {
  keyId: string
  tenantId: string
  scopes: string[]
  createdById: string
}

export const API_KEY_RATE_LIMIT = { limit: 120, windowMs: 60_000 }
export const API_IP_RATE_LIMIT = { limit: 600, windowMs: 60_000 }
const LAST_USED_RESOLUTION_MS = 60_000

export function apiError(status: number, code: string, message: string, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers })
}

type AuthOutcome =
  | { ok: true; caller: ApiCaller; lastUsedAt: Date | null }
  | { ok: false; response: NextResponse; tenantId: string | null; keyId: string | null }

export async function authenticateApiKey(req: Request, now: Date = new Date()): Promise<AuthOutcome> {
  const fail = (status: number, code: string, message: string, tenantId: string | null = null, keyId: string | null = null): AuthOutcome =>
    ({ ok: false, response: apiError(status, code, message, status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined), tenantId, keyId })

  const token = bearerToken(req.headers.get("authorization"))
  if (!token) return fail(401, "missing_api_key", "Send an API key as `Authorization: Bearer <key>`.")
  const prefix = apiKeyPrefix(token)
  if (!prefix) return fail(401, "invalid_api_key", "The API key is not valid.")

  // The tenant is not known until the key is found, so this one lookup runs
  // outside the tenant scope; it is by the key's unique prefix only.
  // Awaited INSIDE the frame: a PrismaPromise is lazy and would otherwise run after it.
  const row = await withoutTenantScope(async () => await prisma.apiKey.findUnique({
    where: { prefix },
    select: {
      id: true, tenantId: true, keyHash: true, scopes: true, createdById: true,
      expiresAt: true, revokedAt: true, lastUsedAt: true,
      tenant: { select: { status: true } },
    },
  }))
  if (!row || !apiKeyMatches(token, row.keyHash)) return fail(401, "invalid_api_key", "The API key is not valid.")

  const state = apiKeyState(row, now)
  if (state !== "active") return fail(401, `api_key_${state}`, `The API key is ${state}.`, row.tenantId, row.id)
  if (row.tenant.status !== "ACTIVE") return fail(403, "tenant_inactive", "This lender is not active.", row.tenantId, row.id)

  return {
    ok: true,
    caller: { keyId: row.id, tenantId: row.tenantId, scopes: row.scopes, createdById: row.createdById },
    lastUsedAt: row.lastUsedAt,
  }
}

async function touchLastUsed(caller: ApiCaller, lastUsedAt: Date | null, now: Date): Promise<void> {
  if (lastUsedAt && now.getTime() - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) return
  await prisma.apiKey.updateMany({
    where: { id: caller.keyId, tenantId: caller.tenantId },
    data: { lastUsedAt: now },
  })
}

async function logRequest(req: Request, entry: { tenantId: string | null; keyId: string | null; status: number; startedAt: number }) {
  try {
    await prisma.apiRequestLog.create({
      data: {
        tenantId: entry.tenantId,
        apiKeyId: entry.keyId,
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

export async function withApiKey(
  req: Request,
  scope: ApiScope,
  handler: (caller: ApiCaller) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now()
  let tenantId: string | null = null
  let keyId: string | null = null
  let response: Response
  try {
    const ipLimit = checkRateLimit(`lender-api:ip:${callerIp(req)}`, API_IP_RATE_LIMIT)
    if (!ipLimit.allowed) {
      response = apiError(429, "rate_limited", "Too many requests.", { "Retry-After": String(ipLimit.retryAfterSeconds) })
    } else {
      const auth = await authenticateApiKey(req)
      if (!auth.ok) {
        tenantId = auth.tenantId
        keyId = auth.keyId
        response = auth.response
      } else {
        const { caller } = auth
        tenantId = caller.tenantId
        keyId = caller.keyId
        if (!hasScope(caller.scopes, scope)) {
          response = apiError(403, "insufficient_scope", `This API key does not have the ${scope} scope.`)
        } else {
          const keyLimit = checkRateLimit(`lender-api:key:${caller.keyId}`, API_KEY_RATE_LIMIT)
          if (!keyLimit.allowed) {
            response = apiError(429, "rate_limited", "Too many requests for this API key.", { "Retry-After": String(keyLimit.retryAfterSeconds) })
          } else {
            response = await runWithTenant(caller.tenantId, async () => {
              await touchLastUsed(caller, auth.lastUsedAt, new Date())
              return handler(caller)
            })
            response.headers.set("X-RateLimit-Limit", String(API_KEY_RATE_LIMIT.limit))
            response.headers.set("X-RateLimit-Remaining", String(keyLimit.remaining))
          }
        }
      }
    }
  } catch (error) {
    console.error("[lender-api] request failed", { path: new URL(req.url).pathname, keyId }, error)
    response = apiError(500, "internal_error", "The request failed.")
  }
  response.headers.set("Cache-Control", "no-store")
  await logRequest(req, { tenantId, keyId, status: response.status, startedAt })
  return response
}
