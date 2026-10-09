import { describe, it, expect, afterEach } from "vitest"
import { sealSecret, isSealed } from "@/lib/crypto/secret-box"
import { sealField, openField, openFieldOrNull } from "./secrets"

const KEY = Buffer.alloc(32, 7).toString("base64")

afterEach(() => {
  delete process.env.WABA_ENC_KEY
})

describe("sealField", () => {
  it("seals a fresh secret", () => {
    process.env.WABA_ENC_KEY = KEY
    const sealed = sealField("smtp-pw")
    expect(typeof sealed).toBe("string")
    expect(isSealed(sealed as string)).toBe(true)
    expect(sealed).not.toContain("smtp-pw")
  })

  it("is idempotent — an already-sealed value passes through untouched", () => {
    process.env.WABA_ENC_KEY = KEY
    const once = sealField("smtp-pw") as string
    expect(sealField(once)).toBe(once)
  })

  it("passes null, undefined and empty string through", () => {
    process.env.WABA_ENC_KEY = KEY
    expect(sealField(null)).toBeNull()
    expect(sealField(undefined)).toBeUndefined()
    expect(sealField("")).toBe("")
  })

  it("FAILS CLOSED — refuses to store a plaintext secret with no key configured", () => {
    expect(() => sealField("smtp-pw")).toThrow(/WABA_ENC_KEY/)
  })

  it("does not need the key to pass an already-sealed value through", () => {
    process.env.WABA_ENC_KEY = KEY
    const sealed = sealField("smtp-pw") as string
    delete process.env.WABA_ENC_KEY
    expect(sealField(sealed)).toBe(sealed)
  })
})

describe("openField", () => {
  it("unseals a sealed value", () => {
    process.env.WABA_ENC_KEY = KEY
    expect(openField(sealSecret("imap-pw", KEY))).toBe("imap-pw")
  })

  it("TOLERANT READ — a legacy plaintext row passes through unchanged", () => {
    expect(openField("legacy-plaintext-pw")).toBe("legacy-plaintext-pw")
  })

  it("throws rather than handing ciphertext back as a password", () => {
    expect(() => openField(sealSecret("imap-pw", KEY))).toThrow(/WABA_ENC_KEY/)
  })

  it("openFieldOrNull passes null through", () => {
    expect(openFieldOrNull(null)).toBeNull()
    expect(openFieldOrNull("plain")).toBe("plain")
  })
})
