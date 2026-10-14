import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { tenantConfigFindUnique, tenantFindUnique } = vi.hoisted(() => ({
  tenantConfigFindUnique: vi.fn(),
  tenantFindUnique: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: tenantConfigFindUnique }, tenant: { findUnique: tenantFindUnique } },
}))

import {
  CredentialInputError,
  isEnvCredentialsTenant,
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
  tenantFindUnique.mockReset()
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
    expect(tenantFindUnique).not.toHaveBeenCalled()
  })

  const env = { id: "env-user", secret: "env-pass" }

  it("lends the environment pair only to the tenant ENV_CREDENTIALS_TENANT_SLUG names", async () => {
    vi.stubEnv("ENV_CREDENTIALS_TENANT_SLUG", "lender-a")
    tenantConfigFindUnique.mockResolvedValue({ experianKey: null })
    tenantFindUnique.mockResolvedValue({ id: "tA" })
    expect(await loadCredentialPair("tA", "experianKey", env)).toEqual(env)
    expect(tenantFindUnique).toHaveBeenCalledWith({ where: { slug: "lender-a" }, select: { id: true } })
    expect(await isEnvCredentialsTenant("tA")).toBe(true)
  })

  it("never lends it to another tenant, whatever the others' statuses (A suspended, B active)", async () => {
    // The breaker's repro: the named owner A is SUSPENDED and B is the only
    // ACTIVE tenant. Under a "single ACTIVE tenant" rule B got A's accounts.
    vi.stubEnv("ENV_CREDENTIALS_TENANT_SLUG", "lender-a")
    tenantConfigFindUnique.mockResolvedValue({ experianKey: null })
    tenantFindUnique.mockResolvedValue({ id: "tA" })
    expect(await loadCredentialPair("tB", "experianKey", env)).toBeNull()
    expect(await isEnvCredentialsTenant("tB")).toBe(false)
  })

  it("lends it to no one when no owner is named, or the named slug is no tenant", async () => {
    vi.stubEnv("ENV_CREDENTIALS_TENANT_SLUG", "")
    tenantConfigFindUnique.mockResolvedValue({ experianKey: null })
    expect(await loadCredentialPair("tA", "experianKey", env)).toBeNull()
    expect(tenantFindUnique).not.toHaveBeenCalled()
    vi.stubEnv("ENV_CREDENTIALS_TENANT_SLUG", "nobody")
    tenantFindUnique.mockResolvedValue(null)
    expect(await loadCredentialPair("tA", "experianKey", env)).toBeNull()
  })
})
