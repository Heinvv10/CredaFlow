import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), audit: vi.fn(),
}))
vi.mock("@/lib/prisma", () => {
  const tx = { oauthClient: { count: h.count, create: h.create, updateMany: h.updateMany, findFirst: h.findFirst }, auditLog: { create: h.audit } }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { createOauthClient, generateClientCredentials, isClientId, MAX_ACTIVE_CLIENTS, oauthClientState, parseMtlsPin, revokeOauthClient } from "./clients"
import { hashApiKey } from "@/lib/lender-api/keys"

const actor = { id: "u1", email: "root@lender.example" }

beforeEach(() => {
  h.count.mockReset().mockResolvedValue(0)
  h.create.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "oc1", ...data }))
  h.updateMany.mockReset().mockResolvedValue({ count: 1 })
  h.findFirst.mockReset().mockResolvedValue(null)
  h.audit.mockReset().mockResolvedValue({})
})

describe("generateClientCredentials", () => {
  it("makes a well-formed id, a long secret and a matching SHA-256", () => {
    const c = generateClientCredentials()
    expect(isClientId(c.clientId)).toBe(true)
    expect(c.secret).toMatch(/^cfs_[A-Za-z0-9_-]{43}$/)
    expect(c.secretHash).toBe(hashApiKey(c.secret))
    expect(generateClientCredentials().secret).not.toBe(c.secret)
  })
  it("rejects look-alike ids", () => {
    for (const bad of ["cfc_xyz", "cfk_0123456789abcdef", "cfc_0123456789ABCDEF", " cfc_0123456789abcdef", ""]) expect(isClientId(bad)).toBe(false)
  })
})

describe("parseMtlsPin", () => {
  const FP = "a".repeat(64)
  it("requires the fingerprint and accepts it with colons and any case", () => {
    expect(parseMtlsPin({ certSha256: "AA:" + "bb".repeat(31) })).toEqual({ subjectDn: null, certSha256: "aa" + "bb".repeat(31) })
    expect(parseMtlsPin({ subjectDn: "CN=a,O=b", certSha256: FP })).toEqual({ subjectDn: "CN=a,O=b", certSha256: FP })
  })
  it.each([
    ["a subject alone", { subjectDn: "CN=a,O=b" }],
    ["nothing", {}],
    ["a short fingerprint", { certSha256: "abc" }],
    ["a non-hex fingerprint", { certSha256: "z".repeat(64) }],
    ["a subject with no attribute", { subjectDn: "just text", certSha256: FP }],
    ["a slash-form subject", { subjectDn: "/C=LS/O=b/CN=a", certSha256: FP }],
    ["a non-string subject", { subjectDn: 5, certSha256: FP }],
  ])("refuses %s", (_l, input) => expect(parseMtlsPin(input)).toBeNull())
})

describe("createOauthClient", () => {
  const args = { tenantId: "t1", actor, name: "Core", scopes: ["loans:read" as const], lifetimeDays: 90, mtls: null }

  it("stores only the secret's hash, returns the secret once, and audits without it", async () => {
    const out = await createOauthClient(args)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const data = h.create.mock.calls[0][0].data
    expect(data).toMatchObject({ tenantId: "t1", createdById: "u1", scopes: ["loans:read"], requireMtls: false })
    expect(data.secretHash).toBe(hashApiKey(out.secret))
    expect(JSON.stringify(data)).not.toContain(out.secret)
    const audit = h.audit.mock.calls[0][0].data
    expect(audit).toMatchObject({ action: "OAUTH_CLIENT_CREATED", entity: "OauthClient", tenantId: "t1", userId: "u1" })
    expect(JSON.stringify(audit)).not.toContain(out.secret)
  })

  it("records the pin and requires mTLS when one is given", async () => {
    await createOauthClient({ ...args, mtls: { subjectDn: "CN=a,O=b", certSha256: "c".repeat(64) } })
    expect(h.create.mock.calls[0][0].data).toMatchObject({ requireMtls: true, mtlsSubjectDn: "CN=a,O=b", mtlsCertSha256: "c".repeat(64) })
  })

  it("refuses beyond the cap and writes nothing", async () => {
    h.count.mockResolvedValue(MAX_ACTIVE_CLIENTS)
    expect(await createOauthClient(args)).toMatchObject({ ok: false, status: 409 })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })
})

describe("revokeOauthClient", () => {
  const rev = () => revokeOauthClient({ tenantId: "t1", actor, id: "oc1" })

  it("revokes inside the lender and audits", async () => {
    expect(await rev()).toBe("revoked")
    expect(h.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "oc1", tenantId: "t1", revokedAt: null } }))
    expect(h.audit.mock.calls[0][0].data).toMatchObject({ action: "OAUTH_CLIENT_REVOKED", entityId: "oc1" })
  })
  it("tells already revoked from missing, auditing neither", async () => {
    h.updateMany.mockResolvedValue({ count: 0 })
    h.findFirst.mockResolvedValue({ id: "oc1" })
    expect(await rev()).toBe("already_revoked")
    h.findFirst.mockResolvedValue(null)
    expect(await rev()).toBe("not_found")
    expect(h.audit).not.toHaveBeenCalled()
  })
})

describe("oauthClientState", () => {
  it("is revoked before expired before active", () => {
    const past = new Date(Date.now() - 1000), future = new Date(Date.now() + 1000)
    expect(oauthClientState({ revokedAt: past, expiresAt: past })).toBe("revoked")
    expect(oauthClientState({ revokedAt: null, expiresAt: past })).toBe("expired")
    expect(oauthClientState({ revokedAt: null, expiresAt: future })).toBe("active")
  })
})
