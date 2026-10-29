import { beforeEach, describe, expect, it, vi } from "vitest"
import { SignJWT } from "jose"

const claims = new Set<string>()
vi.mock("./cache", () => ({
  claimOnce: vi.fn(async (key: string) => (claims.has(key) ? false : (claims.add(key), true))),
}))

import { derivedKey } from "@/lib/crypto/derived-key"
import { mintTicket, readTicket, claimTicket, mintState, readState } from "./tokens"

beforeEach(() => {
  process.env.AUTH_SECRET = "s".repeat(48)
  claims.clear()
})

describe("sign-in ticket", () => {
  it("round-trips the user, lender and MFA proof", async () => {
    const token = await mintTicket({ userId: "u1", tenantId: "t1", mfaReported: true, role: null })
    const ticket = await readTicket(token)
    expect(ticket).toMatchObject({ userId: "u1", tenantId: "t1", mfaReported: true, role: null })
    expect(ticket?.jti).toBeTruthy()
  })

  it("carries the mapped role and refuses a role that is not mappable", async () => {
    expect(await readTicket(await mintTicket({ userId: "u1", tenantId: "t1", mfaReported: false, role: "ADMIN" }))).toMatchObject({ role: "ADMIN" })
    const forged = await new SignJWT({ tid: "t1", mfa: false, rl: "SUPER_ADMIN" })
      .setProtectedHeader({ alg: "HS256" }).setSubject("u1").setAudience("sso-ticket").setJti("j").setExpirationTime("2m")
      .sign(new Uint8Array(derivedKey("sso-ticket")))
    expect(await readTicket(forged)).toBeNull()
  })

  it("refuses an expired ticket", async () => {
    const token = await mintTicket({ userId: "u1", tenantId: "t1", mfaReported: false, role: null }, { ttlSeconds: -10 })
    expect(await readTicket(token)).toBeNull()
  })

  it("refuses a ticket signed with another key", async () => {
    const forged = await new SignJWT({ tid: "t1", mfa: true })
      .setProtectedHeader({ alg: "HS256" }).setSubject("u1").setAudience("sso-ticket").setJti("j").setExpirationTime("2m")
      .sign(new TextEncoder().encode("x".repeat(32)))
    expect(await readTicket(forged)).toBeNull()
  })

  it("refuses an unsigned (alg none) ticket", async () => {
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
      + "." + Buffer.from(JSON.stringify({ sub: "u1", tid: "t1", mfa: true, aud: "sso-ticket", jti: "j", exp: 9999999999 })).toString("base64url") + "."
    expect(await readTicket(none)).toBeNull()
  })

  it("refuses a state cookie presented as a ticket", async () => {
    const state = await mintState({ tenantId: "t1", state: "s", returnTo: "/dashboard" })
    expect(await readTicket(state)).toBeNull()
  })

  it("is single use", async () => {
    const ticket = await readTicket(await mintTicket({ userId: "u1", tenantId: "t1", mfaReported: false, role: null }))
    expect(await claimTicket(ticket!)).toBe(true)
    expect(await claimTicket(ticket!)).toBe(false)
  })

  it("refuses garbage", async () => {
    expect(await readTicket("not-a-jwt")).toBeNull()
    expect(await readTicket("")).toBeNull()
  })
})

describe("flow state", () => {
  it("round-trips", async () => {
    const token = await mintState({ tenantId: "t1", state: "abc", nonce: "n", codeVerifier: "v", returnTo: "/loans" })
    expect(await readState(token)).toMatchObject({ tenantId: "t1", state: "abc", nonce: "n", codeVerifier: "v", returnTo: "/loans" })
  })

  it("carries the SAML request id", async () => {
    expect(await readState(await mintState({ tenantId: "t1", state: "r", requestId: "_abc", returnTo: "/" }))).toMatchObject({ requestId: "_abc" })
  })

  it("refuses an expired state", async () => {
    expect(await readState(await mintState({ tenantId: "t1", state: "a", returnTo: "/" }, { ttlSeconds: -5 }))).toBeNull()
  })

  it("refuses a ticket presented as state", async () => {
    expect(await readState(await mintTicket({ userId: "u", tenantId: "t", mfaReported: false, role: null }))).toBeNull()
  })

  it("refuses a tampered state", async () => {
    const token = await mintState({ tenantId: "t1", state: "a", returnTo: "/" })
    const [h, , s] = token.split(".")
    const forged = [h, Buffer.from(JSON.stringify({ tid: "t2", st: "a", rt: "/", aud: "sso-state", exp: 9999999999 })).toString("base64url"), s].join(".")
    expect(await readState(forged)).toBeNull()
  })

  it("uses a key that differs from the ticket key", () => {
    expect(derivedKey("sso-ticket").equals(derivedKey("sso-state"))).toBe(false)
  })
})
