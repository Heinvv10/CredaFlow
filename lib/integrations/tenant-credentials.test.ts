import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { tenantConfigFindUnique, tenantFindMany } = vi.hoisted(() => ({
  tenantConfigFindUnique: vi.fn(),
  tenantFindMany: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: tenantConfigFindUnique }, tenant: { findMany: tenantFindMany } },
}))

import {
  CredentialInputError,
  isTheSingleActiveTenant,
  loadCredentialPair,
  loadTenantCredential,
  maskCredential,
  openCredential,
  sealCredential,
  splitCredentialPair,
} from "./tenant-credentials"

const KEY = randomBytes(32).toString("base64")

beforeEach(() => {
  vi.stubEnv("WABA_ENC_KEY", KEY)
  tenantConfigFindUnique.mockReset()
  tenantFindMany.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("sealing", () => {
  it("stores ciphertext that opens back to the credential", () => {
    const sealed = sealCredential("synthetic-user:synthetic-pass")
    expect(sealed.startsWith("enc:v1:")).toBe(true)
    expect(sealed).not.toContain("synthetic-pass")
    expect(openCredential(sealed)).toBe("synthetic-user:synthetic-pass")
  })

  it("refuses ciphertext as input: a caller cannot plant a sealed value it did not seal here", () => {
    const sealed = sealCredential("synthetic-secret")
    expect(() => sealCredential(sealed)).toThrow(CredentialInputError)
    expect(() => sealCredential("enc:v1:forged:value:here")).toThrow(CredentialInputError)
  })

  it("refuses to store a credential when no key is configured", () => {
    vi.stubEnv("WABA_ENC_KEY", "")
    expect(() => sealCredential("synthetic-secret")).toThrow(/WABA_ENC_KEY/)
  })

  it("reads a legacy plaintext value as-is, and refuses a sealed one without the key", () => {
    expect(openCredential("legacy-plain")).toBe("legacy-plain")
    const sealed = sealCredential("synthetic-secret")
    vi.stubEnv("WABA_ENC_KEY", "")
    expect(() => openCredential(sealed)).toThrow(/WABA_ENC_KEY/)
  })

  it("masks a credential whole", () => {
    expect(maskCredential(null)).toBe("")
    expect(maskCredential("abcd-secret")).toBe("********")
    expect(maskCredential(sealCredential("abcd-secret"))).toBe("********")
  })

  it("splits a pair at the first colon, so the secret may contain colons", () => {
    expect(splitCredentialPair("id:se:cret")).toEqual({ id: "id", secret: "se:cret" })
    expect(splitCredentialPair("no-colon")).toBeNull()
    expect(splitCredentialPair(":secret")).toBeNull()
    expect(splitCredentialPair("id:")).toBeNull()
  })
})

describe("loading", () => {
  it("opens the tenant's sealed column", async () => {
    tenantConfigFindUnique.mockResolvedValue({ transunionKey: sealCredential("cid:csecret") })
    expect(await loadTenantCredential("t1", "transunionKey")).toBe("cid:csecret")
    expect(tenantConfigFindUnique).toHaveBeenCalledWith({ where: { tenantId: "t1" }, select: { transunionKey: true } })
  })

  it("prefers the tenant's own pair and never consults the environment for it", async () => {
    tenantConfigFindUnique.mockResolvedValue({ experianKey: sealCredential("own-user:own-pass") })
    const pair = await loadCredentialPair("t1", "experianKey", { id: "env-user", secret: "env-pass" })
    expect(pair).toEqual({ id: "own-user", secret: "own-pass" })
    expect(tenantFindMany).not.toHaveBeenCalled()
  })

  const env = { id: "env-user", secret: "env-pass" }

  it("falls back to the environment pair for the deployment's one ACTIVE tenant", async () => {
    tenantConfigFindUnique.mockResolvedValue({ experianKey: null })
    tenantFindMany.mockResolvedValue([{ id: "t1" }])
    expect(await loadCredentialPair("t1", "experianKey", env)).toEqual(env)
    expect(tenantFindMany).toHaveBeenCalledWith({ where: { status: "ACTIVE" }, select: { id: true }, take: 2 })
  })

  it("never lends the environment pair to a tenant that is not that ACTIVE tenant", async () => {
    tenantConfigFindUnique.mockResolvedValue({ experianKey: null })
    // One ACTIVE lender (t1) and one still PROVISIONING (t2): the count of
    // ACTIVE tenants is 1, but the environment accounts are t1's alone.
    tenantFindMany.mockResolvedValue([{ id: "t1" }])
    expect(await loadCredentialPair("t2", "experianKey", env)).toBeNull()
    expect(await isTheSingleActiveTenant("t2")).toBe(false)
    expect(await isTheSingleActiveTenant("t1")).toBe(true)
  })

  it("lends it to no one once a second lender is ACTIVE", async () => {
    tenantConfigFindUnique.mockResolvedValue({ experianKey: null })
    tenantFindMany.mockResolvedValue([{ id: "t1" }, { id: "t3" }])
    expect(await loadCredentialPair("t1", "experianKey", env)).toBeNull()
  })
})
