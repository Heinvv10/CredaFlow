import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { tenantConfigFindUnique, tenantCount } = vi.hoisted(() => ({
  tenantConfigFindUnique: vi.fn(),
  tenantCount: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: tenantConfigFindUnique }, tenant: { count: tenantCount } },
}))

import {
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
  tenantCount.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("sealing", () => {
  it("stores ciphertext that opens back to the credential", () => {
    const sealed = sealCredential("synthetic-user:synthetic-pass")
    expect(sealed.startsWith("enc:v1:")).toBe(true)
    expect(sealed).not.toContain("synthetic-pass")
    expect(openCredential(sealed)).toBe("synthetic-user:synthetic-pass")
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
    expect(tenantCount).not.toHaveBeenCalled()
  })

  it("falls back to the environment pair only on a single-tenant deployment", async () => {
    tenantConfigFindUnique.mockResolvedValue({ experianKey: null })
    tenantCount.mockResolvedValue(1)
    expect(await loadCredentialPair("t1", "experianKey", { id: "env-user", secret: "env-pass" }))
      .toEqual({ id: "env-user", secret: "env-pass" })

    // A second ACTIVE lender: one lender's environment accounts must serve no one.
    tenantCount.mockResolvedValue(2)
    expect(await loadCredentialPair("t1", "experianKey", { id: "env-user", secret: "env-pass" })).toBeNull()
  })
})
