import { describe, it, expect } from "vitest"
import { randomBytes } from "node:crypto"
import { sealSecret, openSecret, isSealed, SecretBoxError } from "./secret-box"

const key = randomBytes(32).toString("base64")

describe("secret-box", () => {
  it("round-trips a value", () => {
    expect(openSecret(sealSecret("EAAB-token", key), key)).toBe("EAAB-token")
  })
  it("produces a different ciphertext each call (random IV)", () => {
    expect(sealSecret("x", key)).not.toBe(sealSecret("x", key))
  })
  it("rejects a tampered ciphertext (auth tag)", () => {
    const sealed = sealSecret("x", key)
    const parts = sealed.split(":")
    // corrupt only the trailing ciphertext segment; the "enc", "v1", iv and
    // tag segments stay intact so the value is still recognized as sealed.
    const bad = [...parts.slice(0, -1), Buffer.from("garbage").toString("base64")].join(":")
    expect(() => openSecret(bad, key)).toThrow(SecretBoxError)
  })
  it("rejects a wrong key", () => {
    const other = randomBytes(32).toString("base64")
    expect(() => openSecret(sealSecret("x", key), other)).toThrow(SecretBoxError)
  })
  it("rejects a key that is not 32 bytes", () => {
    expect(() => sealSecret("x", Buffer.from("short").toString("base64"))).toThrow(SecretBoxError)
  })
  it("rejects a value that is not sealed (no marker)", () => {
    expect(() => openSecret("plain:text:value", key)).toThrow(SecretBoxError)
  })
  it("rejects a sealed marker with the wrong segment count", () => {
    expect(() => openSecret("enc:v1:onlyone", key)).toThrow(SecretBoxError)
  })
})

describe("isSealed", () => {
  it("recognizes a value produced by sealSecret", () => {
    expect(isSealed(sealSecret("x", key))).toBe(true)
  })
  it("does not misclassify plaintext containing colons", () => {
    expect(isSealed("plain:text:value")).toBe(false)
  })
  it("does not misclassify an ordinary token", () => {
    expect(isSealed("EAAB-token")).toBe(false)
  })
})
