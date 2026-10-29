/**
 * Real-Postgres proof of the SSO and OAuth tables: the CHECK constraints that
 * keep the identity provider away from SUPER_ADMIN and password sign-in off only
 * while SSO is on, the single-use cache, the per-request revalidation query, and
 * an OAuth client end to end (create, token, API call, revoke).
 *
 *   RUN_SSO_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/sso/sso-oauth.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { claimOnce, DbSamlCache } from "./cache"
import { saveConnection } from "./connection"
import { revalidatePrincipal } from "@/lib/auth-principal"
import { createOauthClient, revokeOauthClient } from "@/lib/lender-api/oauth/clients"
import { handleTokenRequest } from "@/lib/lender-api/oauth/endpoint"
import { authenticateApiKey } from "@/lib/lender-api/handler"
import { runWithTenant } from "@/lib/tenant-scope"
import { testCertificatePem } from "./test-support/saml-fixture"

const RUN = process.env.RUN_SSO_IT === "1"
const suite = RUN ? describe : describe.skip

const t = randomUUID().replaceAll("-", "").slice(0, 14)
const tenantA = `t_sso_a_${t}`
const tenantB = `t_sso_b_${t}`
const adminA = `u_sso_a_${t}`
const rootA = `u_sso_root_${t}`
const adminB = `u_sso_b_${t}`

suite("SSO and OAuth (real database)", () => {
  const db = new PrismaClient()

  beforeAll(async () => {
    vi.stubEnv("SSO_SECRET_KEY", randomBytes(32).toString("base64"))
    vi.stubEnv("AUTH_SECRET", "s".repeat(48))
    await db.tenant.createMany({ data: [{ id: tenantA, slug: `sso-a-${t}`, name: "SSO IT A" }, { id: tenantB, slug: `sso-b-${t}`, name: "SSO IT B" }] })
    await db.user.createMany({
      data: [
        { id: adminA, tenantId: tenantA, email: `${adminA}@test.invalid`, password: "x", role: "ADMIN" },
        { id: rootA, tenantId: tenantA, email: `${rootA}@test.invalid`, password: "x", role: "SUPER_ADMIN", totpEnabled: true, totpSecret: "SYNTHETICSECRET" },
        { id: adminB, tenantId: tenantB, email: `${adminB}@test.invalid`, password: "x", role: "ADMIN" },
      ],
    })
  })

  afterAll(async () => {
    await db.apiRequestLog.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.oauthClient.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.ssoIdentity.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.ssoConnection.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.auditLog.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.ssoCacheEntry.deleteMany({ where: { key: { contains: t } } })
    await db.user.deleteMany({ where: { id: { in: [adminA, rootA, adminB] } } })
    await db.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await db.$disconnect()
  })

  const oidc = { protocol: "OIDC" as const, allowedEmailDomains: ["bank.example.test"], oidcIssuer: "https://idp.example.test", oidcClientId: "cid", oidcClientSecretSealed: "enc:v1:x", oidcScopes: ["openid"] }
  const saml = { protocol: "SAML" as const, allowedEmailDomains: ["bank.example.test"], samlEntityId: "urn:x", samlIdpEntityId: "https://idp", samlIdpSsoUrl: "https://idp/sso", samlIdpCert: "pem" }
  const refuses = (promise: Promise<unknown>, constraint: string) => expect(promise).rejects.toThrow(new RegExp(constraint))
  const make = (tenantId: string, data: Record<string, unknown>) => db.ssoConnection.create({ data: { tenantId, ...data } as never })

  describe("SsoConnection constraints", () => {
    it("refuses an OIDC connection with no client secret and a SAML one with no certificate", async () => {
      await refuses(make(tenantA, { ...oidc, oidcClientSecretSealed: null }), "SsoConnection_protocol_fields_check")
      await refuses(make(tenantA, { ...saml, samlIdpCert: null }), "SsoConnection_protocol_fields_check")
      await refuses(make(tenantA, { ...saml, samlIdpEntityId: null }), "SsoConnection_protocol_fields_check")
    })

    it("refuses a SUPER_ADMIN or operator role as the provisioning default", async () => {
      for (const role of ["SUPER_ADMIN", "OPERATOR_ADMIN", "OPERATOR_SUPPORT"]) {
        await refuses(make(tenantA, { ...oidc, jitProvisioning: true, jitDefaultRole: role }), "SsoConnection_jit_role_check")
      }
    })

    it("refuses provisioning with no default role", async () => {
      await refuses(make(tenantA, { ...oidc, jitProvisioning: true }), "SsoConnection_jit_needs_role_check")
    })

    it("refuses a group mapping that grants SUPER_ADMIN or an operator role, or is not an object", async () => {
      await refuses(make(tenantA, { ...oidc, groupRoleMap: { a: "ADMIN", b: "SUPER_ADMIN" } }), "SsoConnection_group_map_check")
      await refuses(make(tenantA, { ...oidc, groupRoleMap: { a: "OPERATOR_ADMIN" } }), "SsoConnection_group_map_check")
      await refuses(make(tenantA, { ...oidc, groupRoleMap: ["ADMIN"] }), "SsoConnection_group_map_check")
    })

    it("refuses switching SSO on with no allowed email domains", async () => {
      await refuses(make(tenantA, { ...oidc, enabled: true, allowedEmailDomains: [] }), "SsoConnection_domains_needed_check")
    })

    it("refuses turning password sign-in off while SSO is off", async () => {
      await refuses(make(tenantA, { ...oidc, enabled: false, passwordLoginDisabled: true }), "SsoConnection_password_off_needs_sso_check")
    })

    it("allows one connection per lender, with an ordinary mapping", async () => {
      const row = await make(tenantB, { ...oidc, enabled: true, passwordLoginDisabled: true, groupRoleMap: { staff: "READONLY" }, jitProvisioning: true, jitDefaultRole: "READONLY" })
      expect(row.passwordLoginDisabled).toBe(true)
      await expect(make(tenantB, oidc)).rejects.toThrow(/Unique constraint|tenantId/)
      await db.ssoConnection.delete({ where: { tenantId: tenantB } })
    })
  })

  describe("saveConnection and the per-request revalidation", () => {
    const body = (extra: Record<string, unknown> = {}) => ({
      protocol: "SAML", enabled: true, allowedEmailDomains: ["test.invalid"],
      saml: { entityId: "urn:cf:a", idpEntityId: "https://idp.example.test/saml", idpSsoUrl: "https://idp.example.test/sso", idpCert: testCertificatePem() },
      trustIdpMfa: true, ...extra,
    })

    it("stores the connection and its audit row together, with no secret in the row", async () => {
      const out = await saveConnection({ tenantId: tenantA, actor: { id: rootA, email: "root@test.invalid" }, body: body() })
      expect(out.ok).toBe(true)
      const audit = await db.auditLog.findFirst({ where: { tenantId: tenantA, action: "SSO_CONNECTION_UPDATED" } })
      expect(audit).toMatchObject({ userId: rootA, entity: "SsoConnection" })
      expect(JSON.stringify(audit)).not.toContain("BEGIN CERTIFICATE")
    })

    it("lets revalidatePrincipal see the lender's trust in provider MFA, and only with the session's claim", async () => {
      const lenderRequires = await db.tenantConfig.upsert({ where: { tenantId: tenantA }, create: { tenantId: tenantA, requireStaffTotp: true }, update: { requireStaffTotp: true } })
      expect(lenderRequires.requireStaffTotp).toBe(true)
      const claims = { audience: "staff" as const, totpVerified: false, totpEnrolmentRequired: false }
      const trusted = await revalidatePrincipal(adminA, 0, { ...claims, idpMfa: true })
      expect(trusted).toMatchObject({ totpEnrolmentRequired: false })
      expect(await revalidatePrincipal(adminA, 0, claims)).toMatchObject({ totpEnrolmentRequired: true })
      await saveConnection({ tenantId: tenantA, actor: { id: rootA, email: "root@test.invalid" }, body: body({ trustIdpMfa: false }) })
      expect(await revalidatePrincipal(adminA, 0, { ...claims, idpMfa: true })).toMatchObject({ totpEnrolmentRequired: true })
      await db.tenantConfig.delete({ where: { tenantId: tenantA } })
    })
  })

  describe("SsoIdentity (subject binding)", () => {
    const link = (userId: string, subject: string, tenantId = tenantA) => db.ssoIdentity.create({ data: { tenantId, userId, subject } })

    it("binds one subject per user and one user per subject within a lender", async () => {
      await link(adminA, `https://idp|s-${t}`)
      await expect(link(adminA, `https://idp|other-${t}`)).rejects.toThrow(/Unique constraint/)
      await expect(link(rootA, `https://idp|s-${t}`)).rejects.toThrow(/Unique constraint/)
      await db.ssoIdentity.deleteMany({ where: { tenantId: tenantA } })
    })

    it("refuses binding a subject to another lender's user", async () => {
      await expect(link(adminB, `https://idp|x-${t}`, tenantA)).rejects.toThrow(/Foreign key|tenantId_userId_fkey/)
    })

    it("is cleared when the provider changes, and not when only settings change", async () => {
      await link(adminA, `https://idp.example.test/saml|s-${t}`)
      const actor = { id: rootA, email: "root@test.invalid" }
      const saml = (idpEntityId: string, extra = {}) => ({
        protocol: "SAML", enabled: true, allowedEmailDomains: ["test.invalid"],
        saml: { entityId: "urn:cf:a", idpEntityId, idpSsoUrl: "https://idp.example.test/sso", idpCert: testCertificatePem() }, ...extra,
      })
      await saveConnection({ tenantId: tenantA, actor, body: saml("https://idp.example.test/saml") })
      await saveConnection({ tenantId: tenantA, actor, body: saml("https://idp.example.test/saml", { trustIdpMfa: true }) })
      expect(await db.ssoIdentity.count({ where: { tenantId: tenantA } })).toBe(1)
      await saveConnection({ tenantId: tenantA, actor, body: saml("https://other-idp.example.test/saml") })
      expect(await db.ssoIdentity.count({ where: { tenantId: tenantA } })).toBe(0)
    })
  })

  describe("single-use cache", () => {
    it("lets exactly one of many concurrent claims win", async () => {
      const key = `it-claim-${t}`
      const wins = await Promise.all(Array.from({ length: 8 }, () => claimOnce(key, new Date(Date.now() + 60_000))))
      expect(wins.filter(Boolean)).toHaveLength(1)
    })

    it("hands a SAML request id to exactly one of two concurrent consumers", async () => {
      const cache = new DbSamlCache(`it-${t}`, 60_000)
      await cache.saveAsync("_req", "payload")
      const got = await Promise.all([cache.consumeAsync("_req"), cache.consumeAsync("_req")])
      expect(got.filter((v) => v === "payload")).toHaveLength(1)
    })

    it("lets an expired claim be taken again", async () => {
      const key = `it-expired-${t}`
      expect(await claimOnce(key, new Date(Date.now() - 1000))).toBe(true)
      expect(await claimOnce(key, new Date(Date.now() + 60_000))).toBe(true)
    })
  })

  describe("OAuth clients", () => {
    const form = (id: string, secret: string, extra = "") => new Request("http://localhost/api/auth/oauth/token", {
      method: "POST", body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}${extra}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })

    it("refuses what the database refuses: unknown scope, no scope, mTLS with no pin, a creator of another lender", async () => {
      const row = { tenantId: tenantA, name: "x", clientId: `cfc_${randomBytes(8).toString("hex")}`, secretHash: "h", createdById: adminA, expiresAt: new Date(Date.now() + 86_400_000) }
      const insert = (extra: Record<string, unknown>) => db.oauthClient.create({ data: { ...row, clientId: `cfc_${randomBytes(8).toString("hex")}`, scopes: ["loans:read"], ...extra } })
      await refuses(insert({ scopes: ["admin"] }), "OauthClient_scopes_check")
      await refuses(insert({ scopes: [] }), "OauthClient_scopes_check")
      await refuses(insert({ requireMtls: true }), "OauthClient_mtls_pin_check")
      await refuses(insert({ requireMtls: true, mtlsSubjectDn: "CN=a,O=b" }), "OauthClient_mtls_pin_check")
      await refuses(insert({ requireMtls: true, mtlsCertSha256: "ABC" }), "OauthClient_mtls_pin_check")
      await refuses(insert({ mtlsSubjectDn: "/C=LS/CN=a" }), "OauthClient_mtls_dn_form_check")
      await refuses(insert({ createdById: adminB }), "Foreign key|OauthClient_tenantId_createdById_fkey")
      await refuses(insert({ revokedAt: new Date() }), "OauthClient_revocation_check")
      await refuses(insert({ expiresAt: new Date(Date.now() - 86_400_000) }), "OauthClient_expiry_check")
    })

    it("registers, issues a token, serves a call in the lender, then stops at revocation", async () => {
      const created = await createOauthClient({ tenantId: tenantA, actor: { id: rootA, email: "root@test.invalid" }, name: "Core", scopes: ["clients:read"], lifetimeDays: 30, mtls: null })
      if (!created.ok) throw new Error("not created")
      const stored = await db.oauthClient.findUniqueOrThrow({ where: { clientId: created.clientId } })
      expect(stored.secretHash).not.toContain(created.secret)

      const bad = await handleTokenRequest(form(created.clientId, "cfs_wrong"))
      expect(bad.status).toBe(401)
      const res = await handleTokenRequest(form(created.clientId, created.secret))
      expect(res.status).toBe(200)
      const { access_token: token } = await res.json()

      const asKey = (bearer: string) => authenticateApiKey(new Request("http://localhost/api/v1/clients", { headers: { authorization: `Bearer ${bearer}` } }))
      const ok = await asKey(token)
      expect(ok).toMatchObject({ ok: true, caller: { kind: "oauth_client", tenantId: tenantA, keyId: created.client.id, scopes: ["clients:read"] } })
      expect(await db.apiRequestLog.count({ where: { tenantId: tenantA, oauthClientId: created.client.id } })).toBeGreaterThan(0)

      expect(await runWithTenant(tenantA, () => revokeOauthClient({ tenantId: tenantA, actor: { id: rootA, email: "root@test.invalid" }, id: created.client.id }))).toBe("revoked")
      expect(await asKey(token)).toMatchObject({ ok: false })
      expect((await handleTokenRequest(form(created.clientId, created.secret))).status).toBe(401)
      const audits = await db.auditLog.findMany({ where: { tenantId: tenantA, entity: "OauthClient" }, select: { action: true, newValue: true } })
      expect(audits.map((a) => a.action).sort()).toEqual(["OAUTH_CLIENT_CREATED", "OAUTH_CLIENT_REVOKED"])
      expect(JSON.stringify(audits)).not.toContain(created.secret)
    })

    it("a token minted for one lender's client is no use under another's id", async () => {
      const created = await createOauthClient({ tenantId: tenantA, actor: { id: rootA, email: "root@test.invalid" }, name: "A", scopes: ["clients:read"], lifetimeDays: 30, mtls: null })
      if (!created.ok) throw new Error("not created")
      const { mintAccessToken } = await import("@/lib/lender-api/oauth/access-token")
      const crossed = (await mintAccessToken({ clientRowId: created.client.id, tenantId: tenantB, scopes: ["clients:read"] })).token
      const out = await authenticateApiKey(new Request("http://localhost/api/v1/clients", { headers: { authorization: `Bearer ${crossed}` } }))
      expect(out.ok).toBe(false)
    })
  })

})
