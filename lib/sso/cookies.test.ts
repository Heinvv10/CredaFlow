import { afterEach, describe, expect, it } from "vitest"
import { cookieOptions, flowCookieName, readCookie, ticketCookieName } from "./cookies"
import { isCrossOriginExempt } from "@/lib/proxy/same-origin"

const saved = { AUTH_URL: process.env.AUTH_URL, NEXTAUTH_URL: process.env.NEXTAUTH_URL }
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

describe("SSO cookies", () => {
  it("uses __Host- names and SameSite=None for the cross-site SAML POST on https", () => {
    process.env.NEXTAUTH_URL = "https://app.example.test"; delete process.env.AUTH_URL
    expect(flowCookieName()).toBe("__Host-cf-sso-flow")
    expect(ticketCookieName()).toBe("__Host-cf-sso-ticket")
    expect(cookieOptions(60, true)).toMatchObject({ httpOnly: true, secure: true, sameSite: "none", path: "/" })
    expect(cookieOptions(60, false)).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" })
  })

  it("is plain and lax on http (development)", () => {
    process.env.NEXTAUTH_URL = "http://localhost:3000"; delete process.env.AUTH_URL
    expect(flowCookieName()).toBe("cf-sso-flow")
    expect(cookieOptions(60, true)).toMatchObject({ secure: false, sameSite: "lax" })
  })

  it("reads one cookie by exact name", () => {
    expect(readCookie("a=1; cf-sso-ticket=abc%3D; b=2", "cf-sso-ticket")).toBe("abc=")
    expect(readCookie("xcf-sso-ticket=evil", "cf-sso-ticket")).toBeNull()
    expect(readCookie(null, "x")).toBeNull()
  })
})

describe("same-origin write gate", () => {
  it("exempts only the SAML ACS among the SSO routes", () => {
    expect(isCrossOriginExempt("/api/auth/sso/saml/acs")).toBe(true)
    expect(isCrossOriginExempt("/api/auth/sso/start")).toBe(false)
    expect(isCrossOriginExempt("/api/auth/sso/oidc/callback")).toBe(false)
    expect(isCrossOriginExempt("/api/settings/sso")).toBe(false)
    expect(isCrossOriginExempt("/api/auth/oauth/token")).toBe(false)
  })
})
