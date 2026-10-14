import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sealSecret } from "@/lib/crypto/secret-box"
import { BureauCredentialsError, openBureauCredentials, sealBureauCredentials } from "./credentials"

const key = randomBytes(32).toString("base64")
beforeEach(() => vi.stubEnv("WABA_ENC_KEY", key))
afterEach(() => vi.unstubAllEnvs())

const creds = { xds: { username: "synthetic-user", password: "synthetic-pass", endpointUrl: "https://bureau.invalid" } }

describe("bureau credentials", () => {
  it("round-trips through the secret box and never stores plaintext", () => {
    const sealed = sealBureauCredentials(creds)
    expect(sealed.startsWith("enc:v1:")).toBe(true)
    expect(sealed).not.toContain("synthetic-pass")
    expect(openBureauCredentials(sealed)).toEqual(creds)
  })

  it("treats an empty column as no stored credentials", () => {
    expect(openBureauCredentials(null)).toEqual({})
  })

  it("refuses a plaintext value instead of passing it through", () => {
    expect(() => openBureauCredentials(JSON.stringify(creds))).toThrow(BureauCredentialsError)
  })

  it("refuses to seal or open without the key", () => {
    const sealed = sealBureauCredentials(creds)
    vi.stubEnv("WABA_ENC_KEY", "")
    expect(() => sealBureauCredentials(creds)).toThrow(/WABA_ENC_KEY/)
    expect(() => openBureauCredentials(sealed)).toThrow(/WABA_ENC_KEY/)
  })

  it("refuses a value sealed under another key, and a sealed value that is not a credential map", () => {
    expect(() => openBureauCredentials(sealSecret(JSON.stringify(creds), randomBytes(32).toString("base64"))))
      .toThrow(/could not be opened/)
    expect(() => openBureauCredentials(sealSecret(JSON.stringify({ xds: { port: 22 } }), key))).toThrow(/malformed/)
  })
})
