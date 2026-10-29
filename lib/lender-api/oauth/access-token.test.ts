import { beforeEach, describe, expect, it } from "vitest"
import { SignJWT } from "jose"
import { mintAccessToken, readAccessToken, ACCESS_TOKEN_TTL_SECONDS } from "./access-token"
import { derivedKey } from "@/lib/crypto/derived-key"

beforeEach(() => { process.env.AUTH_SECRET = "s".repeat(48) })

const sample = { clientRowId: "oc1", tenantId: "t1", scopes: ["loans:read", "clients:read"] }

describe("access tokens", () => {
  it("round-trips client, lender and scopes, and is short lived", async () => {
    const { token, expiresIn } = await mintAccessToken(sample)
    expect(expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS)
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(900)
    expect(await readAccessToken(token)).toMatchObject(sample)
  })

  it("refuses an expired token", async () => {
    const { token } = await mintAccessToken(sample, { ttlSeconds: -60 })
    expect(await readAccessToken(token)).toBeNull()
  })

  it("refuses a token signed with another key", async () => {
    const forged = await new SignJWT({ tid: "t1", scope: "pii:read" })
      .setProtectedHeader({ alg: "HS256" }).setSubject("oc1").setAudience("credaflow-lender-api").setIssuer("credaflow").setJti("j").setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)))
    expect(await readAccessToken(forged)).toBeNull()
  })

  it("refuses a token minted for another audience (an SSO ticket)", async () => {
    const other = await new SignJWT({ tid: "t1", scope: "loans:read" })
      .setProtectedHeader({ alg: "HS256" }).setSubject("oc1").setAudience("sso-ticket").setIssuer("credaflow").setJti("j").setExpirationTime("5m")
      .sign(new Uint8Array(derivedKey("oauth-access-token")))
    expect(await readAccessToken(other)).toBeNull()
  })

  it("refuses a correctly signed token whose type is not at+jwt", async () => {
    const wrongTyp = await new SignJWT({ tid: "t1", scope: "pii:read" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject("oc1").setAudience("credaflow-lender-api").setIssuer("credaflow").setJti("j").setExpirationTime("5m")
      .sign(new Uint8Array(derivedKey("oauth-access-token")))
    expect(await readAccessToken(wrongTyp)).toBeNull()
  })

  it("refuses an unsigned token", async () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const none = `${part({ alg: "none", typ: "JWT" })}.${part({ sub: "oc1", tid: "t1", scope: "pii:read", aud: "credaflow-lender-api", iss: "credaflow", jti: "j", exp: 9999999999 })}.`
    expect(await readAccessToken(none)).toBeNull()
  })

  it("refuses a token whose payload was edited to widen its scope", async () => {
    const { token } = await mintAccessToken({ ...sample, scopes: ["loans:read"] })
    const [h, , s] = token.split(".")
    const payload = Buffer.from(JSON.stringify({ sub: "oc1", tid: "t1", scope: "pii:read", aud: "credaflow-lender-api", iss: "credaflow", jti: "j", exp: 9999999999 })).toString("base64url")
    expect(await readAccessToken(`${h}.${payload}.${s}`)).toBeNull()
  })

  it("refuses garbage and an API key", async () => {
    expect(await readAccessToken("nope")).toBeNull()
    expect(await readAccessToken("cfk_0123456789ab_" + "A".repeat(43))).toBeNull()
  })

  it("refuses a token with no scope", async () => {
    const { token } = await mintAccessToken({ ...sample, scopes: [] })
    expect(await readAccessToken(token)).toBeNull()
  })
})
