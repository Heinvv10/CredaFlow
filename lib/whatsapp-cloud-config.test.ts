import { describe, it, expect } from "vitest"
import { resolveWabaCreds, WabaNotConfiguredError } from "./whatsapp-cloud-config"
import { sealSecret } from "@/lib/crypto/secret-box"
import { randomBytes } from "node:crypto"

describe("resolveWabaCreds", () => {
  it("returns creds when both phoneNumberId and accessToken are present", () => {
    expect(
      resolveWabaCreds({ wabaPhoneNumberId: "123", wabaAccessToken: "tok" }, "tn1"),
    ).toEqual({ phoneNumberId: "123", accessToken: "tok" })
  })

  it("trims surrounding whitespace", () => {
    expect(
      resolveWabaCreds({ wabaPhoneNumberId: " 123 ", wabaAccessToken: " tok " }, "tn1"),
    ).toEqual({ phoneNumberId: "123", accessToken: "tok" })
  })

  it("throws WabaNotConfiguredError when settings row is null", () => {
    expect(() => resolveWabaCreds(null, "tn1")).toThrow(WabaNotConfiguredError)
  })

  it("throws when a field is missing or blank", () => {
    expect(() => resolveWabaCreds({ wabaPhoneNumberId: "123", wabaAccessToken: "" }, "tn1"))
      .toThrow(WabaNotConfiguredError)
    expect(() => resolveWabaCreds({ wabaPhoneNumberId: null, wabaAccessToken: "tok" }, "tn1"))
      .toThrow(WabaNotConfiguredError)
  })
})

describe("resolveWabaCreds — sealed token", () => {
  it("decrypts a sealed wabaAccessToken with WABA_ENC_KEY", () => {
    const key = randomBytes(32).toString("base64")
    process.env.WABA_ENC_KEY = key
    const sealed = sealSecret("EAAB-real", key)
    // resolveWabaCreds now opens the token when it carries the sealed marker
    expect(resolveWabaCreds({ wabaPhoneNumberId: "PN1", wabaAccessToken: sealed }, "tn1"))
      .toEqual({ phoneNumberId: "PN1", accessToken: "EAAB-real" })
    delete process.env.WABA_ENC_KEY
  })

  it("passes a plaintext token through unchanged (pre-migration rows)", () => {
    expect(resolveWabaCreds({ wabaPhoneNumberId: "PN1", wabaAccessToken: "plain" }, "tn1"))
      .toEqual({ phoneNumberId: "PN1", accessToken: "plain" })
  })

  it("throws when a sealed token is stored but WABA_ENC_KEY is unset (fail-closed)", () => {
    const key = randomBytes(32).toString("base64")
    const sealed = sealSecret("EAAB-real", key)
    delete process.env.WABA_ENC_KEY
    expect(() => resolveWabaCreds({ wabaPhoneNumberId: "PN1", wabaAccessToken: sealed }, "tn1"))
      .toThrow(/WABA_ENC_KEY/)
  })
})
