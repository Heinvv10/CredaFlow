import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  upsert: vi.fn(),
  clearLinks: vi.fn(),
  audit: vi.fn(),
}))
vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: async () => 1,
    ssoConnection: { findUnique: async () => h.existing, upsert: h.upsert },
    ssoIdentity: { deleteMany: h.clearLinks },
    auditLog: { create: h.audit },
  }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { connectionView, openClientSecret, saveConnection } from "./connection"
import { openSecret } from "@/lib/crypto/secret-box"

const KEY = Buffer.alloc(32, 5).toString("base64")
const actor = { id: "u1", email: "root@lender.example" }
const body = { protocol: "OIDC", enabled: true, allowedEmailDomains: ["bank.example.test"], oidc: { issuer: "https://idp.example.test", clientId: "cid", clientSecret: "very-secret-value" }, groupRoleMap: { admins: "ADMIN" } }

beforeEach(() => {
  process.env.SSO_SECRET_KEY = KEY
  h.existing = null
  h.upsert.mockReset().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: "c1", updatedAt: new Date(), ...create }))
  h.audit.mockReset().mockResolvedValue({})
  h.clearLinks.mockReset().mockResolvedValue({ count: 0 })
})

describe("saveConnection", () => {
  it("seals the client secret, audits the change, and never echoes the secret", async () => {
    const out = await saveConnection({ tenantId: "t1", actor, body })
    expect(out.ok).toBe(true)
    const data = h.upsert.mock.calls[0][0].create
    expect(data.oidcClientSecretSealed).toMatch(/^enc:v1:/)
    expect(openSecret(data.oidcClientSecretSealed, KEY)).toBe("very-secret-value")
    expect(data.updatedById).toBe("u1")
    expect(JSON.stringify(out)).not.toContain("very-secret-value")
    const audit = h.audit.mock.calls[0][0].data
    expect(audit).toMatchObject({ action: "SSO_CONNECTION_UPDATED", entity: "SsoConnection", tenantId: "t1", userId: "u1", oldValue: expect.anything() })
    expect(JSON.stringify(audit)).not.toContain("very-secret-value")
    expect(JSON.stringify(audit)).not.toContain("enc:v1")
    expect(audit.newValue).toMatchObject({ clientSecretChanged: true, groupRoleMap: { admins: "ADMIN" } })
  })

  it("keeps the stored secret when none is sent", async () => {
    h.existing = { protocol: "OIDC", oidcClientSecretSealed: "enc:v1:old", enabled: true }
    h.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => ({ id: "c1", updatedAt: new Date(), ...update }))
    const out = await saveConnection({ tenantId: "t1", actor, body: { ...body, oidc: { issuer: "https://idp.example.test", clientId: "cid" } } })
    expect(out.ok).toBe(true)
    expect(h.upsert.mock.calls[0][0].update.oidcClientSecretSealed).toBe("enc:v1:old")
    expect(h.audit.mock.calls[0][0].data.newValue.clientSecretChanged).toBe(false)
  })

  it("refuses enabling with no allowed email domains and writes nothing", async () => {
    const out = await saveConnection({ tenantId: "t1", actor, body: { ...body, allowedEmailDomains: [] } })
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it("clears the bound subjects when the provider changes, and says so in the audit row", async () => {
    h.existing = { protocol: "OIDC", oidcIssuer: "https://old-idp.example.test", oidcClientSecretSealed: "enc:v1:old", enabled: true }
    h.clearLinks.mockResolvedValue({ count: 3 })
    h.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => ({ id: "c1", updatedAt: new Date(), ...update }))
    await saveConnection({ tenantId: "t1", actor, body })
    expect(h.clearLinks).toHaveBeenCalledWith({ where: { tenantId: "t1" } })
    expect(h.audit.mock.calls[0][0].data.newValue.subjectLinksCleared).toBe(3)
  })

  it("keeps the bound subjects when only settings change", async () => {
    h.existing = { protocol: "OIDC", oidcIssuer: "https://idp.example.test", oidcClientSecretSealed: "enc:v1:old", enabled: true }
    h.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => ({ id: "c1", updatedAt: new Date(), ...update }))
    await saveConnection({ tenantId: "t1", actor, body })
    expect(h.clearLinks).not.toHaveBeenCalled()
  })

  it("refuses a Super Admin mapping and writes nothing", async () => {
    const out = await saveConnection({ tenantId: "t1", actor, body: { ...body, groupRoleMap: { g: "SUPER_ADMIN" } } })
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(h.upsert).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("says so when the server has no SSO_SECRET_KEY", async () => {
    delete process.env.SSO_SECRET_KEY
    expect(await saveConnection({ tenantId: "t1", actor, body })).toMatchObject({ ok: false, status: 503 })
  })
})

describe("connectionView and openClientSecret", () => {
  it("shows whether a secret and certificate exist, never their value", () => {
    const view = connectionView({
      protocol: "SAML", enabled: true, oidcIssuer: null, oidcClientId: null, oidcClientSecretSealed: "enc:v1:x", oidcScopes: [],
      samlEntityId: "urn:x", samlIdpEntityId: "https://idp", samlIdpSsoUrl: "https://idp/sso", samlIdpCert: "-----BEGIN CERTIFICATE-----",
      emailClaim: "email", groupsClaim: "groups", allowedEmailDomains: [], groupRoleMap: {}, jitProvisioning: false, jitDefaultRole: null,
      mfaAcrValues: [], passwordLoginDisabled: false, sessionHours: 10, updatedAt: new Date(),
    } as never)
    expect(view).toMatchObject({ oidc: { hasClientSecret: true }, saml: { hasIdpCert: true } })
    expect(JSON.stringify(view)).not.toContain("enc:v1")
    expect(JSON.stringify(view)).not.toContain("BEGIN CERTIFICATE")
  })

  it("refuses to open a secret without the key", () => {
    delete process.env.SSO_SECRET_KEY
    expect(() => openClientSecret({ oidcClientSecretSealed: "enc:v1:x" })).toThrow()
  })
})
