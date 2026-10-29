import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  clientFindUnique: vi.fn(),
  clientFindFirst: vi.fn(),
  clientUpdateMany: vi.fn(),
  logCreate: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    oauthClient: { findUnique: h.clientFindUnique, findFirst: h.clientFindFirst, updateMany: h.clientUpdateMany },
    apiKey: { findUnique: vi.fn(), updateMany: vi.fn() },
    apiRequestLog: { create: h.logCreate },
  },
}))

import { handleTokenRequest, TOKEN_CLIENT_RATE_LIMIT, TOKEN_FAILED_GLOBAL_LIMIT } from "./endpoint"
import { generateClientCredentials } from "./clients"
import { mintAccessToken } from "./access-token"
import { API_KEY_RATE_LIMIT, withApiKey } from "@/lib/lender-api/handler"
import { getCurrentTenantId } from "@/lib/tenant-scope"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import type { ApiScope } from "@/lib/lender-api/scopes"
import { X509Certificate } from "node:crypto"
import { testIdp } from "@/lib/sso/test-support/saml-fixture"

const CERT_PEM = testIdp("oauth-client").certPem
const CERT_FP = new X509Certificate(CERT_PEM).fingerprint256.replace(/:/g, "").toLowerCase()

const creds = generateClientCredentials()
const future = new Date(Date.now() + 86_400_000)
const past = new Date(Date.now() - 86_400_000)
const row = (extra: Record<string, unknown> = {}) => ({
  id: "oc-A", tenantId: "tenant-A", secretHash: creds.secretHash, scopes: ["clients:read", "loans:read"], createdById: "user-A",
  expiresAt: future, revokedAt: null, lastUsedAt: null, requireMtls: false, mtlsSubjectDn: null, mtlsCertSha256: null,
  tenant: { status: "ACTIVE" }, createdBy: { active: true, role: "ADMIN" }, ...extra,
})

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`
function tokenCall(body: string, headers: Record<string, string> = {}) {
  return handleTokenRequest(new Request("http://localhost/api/auth/oauth/token", {
    method: "POST", body,
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic(creds.clientId, creds.secret), ...headers },
  }))
}
const grant = "grant_type=client_credentials"
const lastLog = () => h.logCreate.mock.calls.at(-1)![0].data

beforeEach(() => {
  process.env.AUTH_SECRET = "s".repeat(48)
  delete process.env.MTLS_TRUSTED_PROXY
  _resetRateLimitStore()
  h.clientFindUnique.mockReset().mockResolvedValue(row())
  h.clientFindFirst.mockReset().mockResolvedValue(row())
  h.clientUpdateMany.mockReset().mockResolvedValue({ count: 1 })
  h.logCreate.mockReset().mockResolvedValue({})
})

describe("POST /api/auth/oauth/token", () => {
  it("issues a bearer token with the client's scopes (Basic authentication)", async () => {
    const res = await tokenCall(grant)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("pragma")).toBe("no-cache")
    const body = await res.json()
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "clients:read loans:read" })
    expect(body.access_token.split(".")).toHaveLength(3)
    expect(h.clientFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: creds.clientId } }))
    expect(lastLog()).toMatchObject({ tenantId: "tenant-A", oauthClientId: "oc-A", apiKeyId: null, path: "/api/auth/oauth/token", status: 200 })
  })

  it("accepts credentials in the form body", async () => {
    const res = await tokenCall(`${grant}&client_id=${creds.clientId}&client_secret=${creds.secret}`, { authorization: "" })
    expect(res.status).toBe(200)
  })

  it("narrows the token to the scopes asked for", async () => {
    const body = await (await tokenCall(`${grant}&scope=loans:read`)).json()
    expect(body.scope).toBe("loans:read")
  })

  it.each([
    ["a scope the client does not hold", "scope=pii:read"],
    ["an unknown scope", "scope=admin"],
  ])("refuses %s with invalid_scope", async (_l, scope) => {
    const res = await tokenCall(`${grant}&${scope}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "invalid_scope" })
  })

  it("refuses a wrong secret and an unknown client alike", async () => {
    const wrong = await tokenCall(grant, { authorization: basic(creds.clientId, "cfs_wrong") })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get("www-authenticate")).toMatch(/^Basic/)
    expect(await wrong.json()).toMatchObject({ error: "invalid_client" })
    h.clientFindUnique.mockResolvedValue(null)
    const unknown = await tokenCall(grant)
    expect(unknown.status).toBe(401)
    expect(await unknown.json()).toMatchObject({ error: "invalid_client" })
    expect(h.clientUpdateMany).not.toHaveBeenCalled()
  })

  it("refuses a malformed client id without a lookup", async () => {
    const res = await tokenCall(grant, { authorization: basic("not-a-client", "x") })
    expect(res.status).toBe(401)
    expect(h.clientFindUnique).not.toHaveBeenCalled()
  })

  it.each([
    ["a revoked client", { revokedAt: past }],
    ["an expired client", { expiresAt: past }],
    ["a suspended lender", { tenant: { status: "SUSPENDED" } }],
    ["a creator who is no longer an admin", { createdBy: { active: true, role: "CREDIT_OFFICER" } }],
    ["a deactivated creator", { createdBy: { active: false, role: "ADMIN" } }],
  ])("refuses %s even with the right secret", async (_l, extra) => {
    h.clientFindUnique.mockResolvedValue(row(extra))
    const res = await tokenCall(grant)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "invalid_client" })
  })

  it.each([
    ["another grant type", "grant_type=password&username=a&password=b", "unsupported_grant_type"],
    ["no grant type", "", "invalid_request"],
    ["two grant types", `${grant}&grant_type=client_credentials`, "invalid_request"],
  ])("refuses %s", async (_l, body, error) => {
    const res = await tokenCall(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error })
  })

  it("refuses two authentication methods at once", async () => {
    const res = await tokenCall(`${grant}&client_id=${creds.clientId}&client_secret=${creds.secret}`)
    expect(await res.json()).toMatchObject({ error: "invalid_request" })
  })

  it("refuses a JSON body", async () => {
    const res = await tokenCall(JSON.stringify({ grant_type: "client_credentials" }), { "content-type": "application/json" })
    expect(res.status).toBe(400)
  })

  it("answers 429 once failed attempts from an unattributed caller pile up, and never for a valid client", async () => {
    for (let i = 0; i < TOKEN_FAILED_GLOBAL_LIMIT.limit; i++) await tokenCall(grant, { authorization: basic(creds.clientId, "cfs_wrong") })
    expect((await tokenCall(grant, { authorization: basic(creds.clientId, "cfs_wrong") })).status).toBe(429)
    expect((await tokenCall(grant)).status).toBe(200)
  })

  it("limits a client's own token requests", async () => {
    for (let i = 0; i < TOKEN_CLIENT_RATE_LIMIT.limit; i++) expect((await tokenCall(grant)).status).toBe(200)
    const res = await tokenCall(grant)
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
  })

  describe("mutual TLS", () => {
    const pinned = () => h.clientFindUnique.mockResolvedValue(row({ requireMtls: true, mtlsCertSha256: CERT_FP }))
    const cert = { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-cert": encodeURIComponent(CERT_PEM) }

    it("refuses a client that requires a certificate when the proxy is not trusted", async () => {
      pinned()
      const res = await tokenCall(grant, cert)
      expect(res.status).toBe(401)
    })

    it("issues a token when the trusted proxy forwards the pinned, verified certificate", async () => {
      process.env.MTLS_TRUSTED_PROXY = "1"
      pinned()
      expect((await tokenCall(grant, cert)).status).toBe(200)
    })

    it("refuses another certificate subject or none", async () => {
      process.env.MTLS_TRUSTED_PROXY = "1"
      pinned()
      expect((await tokenCall(grant, { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-cert": encodeURIComponent(testIdp("oauth-other").certPem) })).status).toBe(401)
      expect((await tokenCall(grant)).status).toBe(401)
    })
  })
})

describe("OAuth client source-address allowlist", () => {
  const allow = ["198.51.100.0/24"]
  const viaProxy = (xff: string) => ({ "x-forwarded-for": xff })
  afterEach(() => { delete process.env.TRUSTED_PROXY })

  it("refuses a token request from outside the allowlist, and serves one from inside", async () => {
    process.env.TRUSTED_PROXY = "1"
    h.clientFindUnique.mockResolvedValue(row({ ipAllowlist: allow }))
    expect((await tokenCall(grant, viaProxy("203.0.113.9"))).status).toBe(401)
    expect((await tokenCall(grant, viaProxy("198.51.100.4"))).status).toBe(200)
  })

  it("refuses an API call with a valid token from outside the allowlist (403), and from an unknown address", async () => {
    h.clientFindFirst.mockResolvedValue(row({ ipAllowlist: allow }))
    const token = (await mintAccessToken({ clientRowId: "oc-A", tenantId: "tenant-A", scopes: ["clients:read"] })).token
    const callFrom = (headers: Record<string, string>) => {
      const handler = vi.fn(async () => NextResponse.json({}))
      return withApiKey(new Request("http://localhost/api/v1/clients", { headers: { authorization: `Bearer ${token}`, ...headers } }), "clients:read", handler).then((res) => ({ res, handler }))
    }
    process.env.TRUSTED_PROXY = "1"
    const outside = await callFrom(viaProxy("203.0.113.9"))
    expect(outside.res.status).toBe(403)
    expect((await outside.res.json()).error.code).toBe("ip_not_allowed")
    expect(outside.handler).not.toHaveBeenCalled()
    expect((await callFrom(viaProxy("198.51.100.4"))).res.status).toBe(200)
    delete process.env.TRUSTED_PROXY
    expect((await callFrom(viaProxy("198.51.100.4"))).res.status).toBe(403)
  })
})

describe("/api/v1 with an access token", () => {
  async function bearer(scopes = ["clients:read", "loans:read"], ttl?: number) {
    return (await mintAccessToken({ clientRowId: "oc-A", tenantId: "tenant-A", scopes }, ttl === undefined ? {} : { ttlSeconds: ttl })).token
  }
  async function call(token: string, scope: ApiScope = "clients:read", headers: Record<string, string> = {}) {
    const handler = vi.fn(async () => NextResponse.json({ tenant: getCurrentTenantId() }))
    const res = await withApiKey(new Request("http://localhost/api/v1/clients", { headers: { authorization: `Bearer ${token}`, ...headers } }), scope, handler)
    return { res, handler }
  }

  it("runs the handler in the client's lender, logs the client, and stamps last use", async () => {
    const { res, handler } = await call(await bearer())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenant: "tenant-A" })
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ kind: "oauth_client", keyId: "oc-A", tenantId: "tenant-A" }))
    expect(lastLog()).toMatchObject({ tenantId: "tenant-A", oauthClientId: "oc-A", apiKeyId: null, status: 200 })
    expect(h.clientUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "oc-A", tenantId: "tenant-A" } }))
    expect(res.headers.get("x-ratelimit-limit")).toBe(String(API_KEY_RATE_LIMIT.limit))
  })

  it("refuses a token that lacks the route's scope", async () => {
    const { res, handler } = await call(await bearer(["loans:read"]), "clients:read")
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("insufficient_scope")
    expect(handler).not.toHaveBeenCalled()
  })

  it("honours a scope narrowed on the client after the token was issued", async () => {
    h.clientFindFirst.mockResolvedValue(row({ scopes: ["loans:read"] }))
    const { res } = await call(await bearer(["clients:read", "loans:read"]), "clients:read")
    expect(res.status).toBe(403)
  })

  it("refuses an expired token", async () => {
    const { res, handler } = await call(await bearer(["clients:read"], -60))
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toContain("invalid_token")
    expect(handler).not.toHaveBeenCalled()
  })

  it("refuses a tampered token", async () => {
    const token = await bearer()
    const { res } = await call(token.slice(0, -4) + "AAAA")
    expect(res.status).toBe(401)
  })

  it("refuses a token for a client that is not in the token's lender", async () => {
    h.clientFindFirst.mockResolvedValue(null)
    expect((await call(await bearer())).res.status).toBe(401)
    expect(h.clientFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "oc-A", tenantId: "tenant-A" } }))
  })

  it.each([
    ["revoked", { revokedAt: past }],
    ["expired", { expiresAt: past }],
    ["creator demoted", { createdBy: { active: true, role: "READONLY" } }],
  ])("stops a live token the moment the client is %s", async (_l, extra) => {
    h.clientFindFirst.mockResolvedValue(row(extra))
    const { res, handler } = await call(await bearer())
    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it("refuses a token of a suspended lender", async () => {
    h.clientFindFirst.mockResolvedValue(row({ tenant: { status: "SUSPENDED" } }))
    expect((await call(await bearer())).res.status).toBe(403)
  })

  it("binds the token to the client certificate: a stolen token without it is refused", async () => {
    h.clientFindFirst.mockResolvedValue(row({ requireMtls: true, mtlsCertSha256: CERT_FP }))
    process.env.MTLS_TRUSTED_PROXY = "1"
    expect((await call(await bearer())).res.status).toBe(401)
    expect((await call(await bearer(), "clients:read", { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-cert": encodeURIComponent(CERT_PEM) })).res.status).toBe(200)
  })

  it("rate limits per client, sharing nothing with API keys", async () => {
    const token = await bearer()
    for (let i = 0; i < API_KEY_RATE_LIMIT.limit; i++) expect((await call(token)).res.status).toBe(200)
    expect((await call(token)).res.status).toBe(429)
  })

  it("still refuses a junk bearer that is neither a key nor a token", async () => {
    const { res } = await call("not-a-credential")
    expect(res.status).toBe(401)
    expect(h.clientFindFirst).not.toHaveBeenCalled()
  })
})
