/**
 * Xero Accounting API client, built to Xero's public documentation:
 *  - OAuth 2.0 authorization code flow with PKCE (S256), refresh tokens
 *    (rotating; `offline_access`), https://login.xero.com/identity/connect/*
 *  - GET /connections lists the organisations a token may use; requests name
 *    one with the `xero-tenant-id` header
 *  - PUT /api.xro/2.0/ManualJournals creates a manual journal; JournalLines
 *    carry LineAmount positive for a debit, negative for a credit
 *  - 429 answers carry Retry-After (seconds); the documented limits are 60
 *    calls a minute and 5 concurrent per organisation, 5,000 a day
 *  - the Idempotency-Key header makes a repeated create return the original
 *
 * UNPROVEN: no Xero developer app exists yet, so none of this has met the real
 * API. Every test stubs fetch. Scopes default to the long-standing
 * `accounting.transactions accounting.settings.read offline_access`. Xero is
 * moving new apps to granular scopes; a manual-journals-only scope (likely
 * `accounting.manualjournals`) would be narrower, but its exact name could not
 * be verified here, so XERO_SCOPES overrides the default once the developer
 * app shows which scopes it is offered.
 *
 * Errors say whether the request could have taken effect: a 4xx answer and an
 * exhausted 429 are DEFINITE (nothing created); a network failure or a 5xx is
 * UNKNOWN and must not be retried by code.
 */
import { createHash, randomBytes } from "node:crypto"

export const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize"
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
export const XERO_REVOKE_URL = "https://identity.xero.com/connect/revocation"
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
export const XERO_MANUAL_JOURNALS_URL = "https://api.xero.com/api.xro/2.0/ManualJournals"
const DEFAULT_SCOPES = "offline_access accounting.transactions accounting.settings.read"

export interface XeroHttp {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** 429 retries before giving up (default 3). */
  maxRetries?: number
}

export class XeroError extends Error {
  constructor(readonly kind: "definite" | "unknown" | "auth" | "config", message: string, readonly status?: number) {
    super(message)
    this.name = "XeroError"
  }
}

export interface XeroAppConfig {
  clientId: string
  clientSecret: string | null
  redirectUri: string
  scopes: string
}

/** The app registration, from env. Null when Xero is not set up on this deployment. */
export function xeroAppConfig(env: NodeJS.ProcessEnv = process.env): XeroAppConfig | null {
  const clientId = env.XERO_CLIENT_ID?.trim()
  const redirectUri = env.XERO_REDIRECT_URI?.trim()
  if (!clientId || !redirectUri) return null
  return { clientId, clientSecret: env.XERO_CLIENT_SECRET?.trim() || null, redirectUri, scopes: env.XERO_SCOPES?.trim() || DEFAULT_SCOPES }
}

const b64url = (buf: Buffer) => buf.toString("base64url")

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) }
}

export function authorizeUrl(config: XeroAppConfig, state: string, challenge: string): string {
  const url = new URL(XERO_AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("redirect_uri", config.redirectUri)
  url.searchParams.set("scope", config.scopes)
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One request, retried only on 429 (which means "not processed"), honouring Retry-After. */
export async function xeroFetch(url: string, init: RequestInit, http: XeroHttp = {}): Promise<Response> {
  const doFetch = http.fetch ?? fetch
  const sleep = http.sleep ?? defaultSleep
  const maxRetries = http.maxRetries ?? 3
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await doFetch(url, init)
    } catch (error) {
      throw new XeroError("unknown", `Xero request failed: ${error instanceof Error ? error.message : "network error"}`)
    }
    if (res.status !== 429) return res
    if (attempt >= maxRetries) throw new XeroError("definite", "Xero rate limit: still refused after retrying", 429)
    const retryAfter = Number(res.headers.get("retry-after"))
    const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) : 2 ** attempt
    await sleep(seconds * 1000)
  }
}

export interface XeroTokens {
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

async function tokenRequest(config: XeroAppConfig, form: Record<string, string>, http: XeroHttp, now: Date): Promise<XeroTokens> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
  const body = new URLSearchParams(form)
  if (config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`
  } else {
    body.set("client_id", config.clientId)
  }
  const res = await xeroFetch(XERO_TOKEN_URL, { method: "POST", headers, body: body.toString() }, http)
  const json = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null
  if (!res.ok || !json?.access_token || !json.refresh_token) {
    // Never echo the body: a token endpoint answer can carry secrets.
    throw new XeroError("auth", `Xero token request refused (${res.status}${json?.error ? `: ${json.error}` : ""})`, res.status)
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: new Date(now.getTime() + (json.expires_in ?? 1800) * 1000) }
}

export function exchangeCode(config: XeroAppConfig, args: { code: string; verifier: string }, http: XeroHttp = {}, now = new Date()) {
  return tokenRequest(config, { grant_type: "authorization_code", code: args.code, redirect_uri: config.redirectUri, code_verifier: args.verifier }, http, now)
}

export function refreshTokens(config: XeroAppConfig, refreshToken: string, http: XeroHttp = {}, now = new Date()) {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken }, http, now)
}

export interface XeroOrganisation {
  connectionId: string
  tenantId: string
  tenantName: string
}

export async function listOrganisations(accessToken: string, http: XeroHttp = {}): Promise<XeroOrganisation[]> {
  const res = await xeroFetch(XERO_CONNECTIONS_URL, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, http)
  if (!res.ok) throw new XeroError(res.status === 401 ? "auth" : "definite", `Xero connections request refused (${res.status})`, res.status)
  const rows = (await res.json()) as Array<{ id?: string; tenantId?: string; tenantName?: string; tenantType?: string }>
  return rows
    .filter((r) => r.tenantType === undefined || r.tenantType === "ORGANISATION")
    .filter((r): r is { id: string; tenantId: string; tenantName: string } => Boolean(r.id && r.tenantId))
    .map((r) => ({ connectionId: r.id, tenantId: r.tenantId, tenantName: r.tenantName ?? r.tenantId }))
}

/** Best-effort cleanup at disconnect; failures are the caller's to log. */
export async function removeConnection(accessToken: string, connectionId: string, http: XeroHttp = {}): Promise<boolean> {
  const res = await xeroFetch(`${XERO_CONNECTIONS_URL}/${encodeURIComponent(connectionId)}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } }, http)
  return res.ok
}

export async function revokeRefreshToken(config: XeroAppConfig, refreshToken: string, http: XeroHttp = {}): Promise<boolean> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  const body = new URLSearchParams({ token: refreshToken })
  if (config.clientSecret) headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`
  else body.set("client_id", config.clientId)
  const res = await xeroFetch(XERO_REVOKE_URL, { method: "POST", headers, body: body.toString() }, http)
  return res.ok
}

export interface ManualJournal {
  Narration: string
  Date: string
  Status: "DRAFT" | "POSTED"
  LineAmountTypes: "NoTax" | "Inclusive"
  JournalLines: Array<{ LineAmount: number; AccountCode: string; Description: string; TaxType?: string }>
}

export async function createManualJournal(args: {
  accessToken: string
  xeroTenantId: string
  journal: ManualJournal
  idempotencyKey: string
}, http: XeroHttp = {}): Promise<{ manualJournalId: string }> {
  const res = await xeroFetch(XERO_MANUAL_JOURNALS_URL, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "xero-tenant-id": args.xeroTenantId,
      "idempotency-key": args.idempotencyKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ ManualJournals: [args.journal] }),
  }, http)
  if (res.status >= 500) throw new XeroError("unknown", `Xero answered ${res.status}; the journal may or may not exist`, res.status)
  const json = (await res.json().catch(() => null)) as { ManualJournals?: Array<{ ManualJournalID?: string }>; Message?: string } | null
  if (!res.ok) throw new XeroError(res.status === 401 ? "auth" : "definite", `Xero refused the journal (${res.status}${json?.Message ? `: ${json.Message}` : ""})`, res.status)
  const id = json?.ManualJournals?.[0]?.ManualJournalID
  if (!id) throw new XeroError("unknown", "Xero accepted the request but returned no journal id")
  return { manualJournalId: id }
}
