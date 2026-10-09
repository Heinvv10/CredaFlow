import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  portalContinueUrl,
  portalDocumentsUrl,
  portalLoginUrl,
  portalRegisterUrl,
  portalUrlOrNull,
  safePortalPath,
} from "./portal-urls"
import { DeploymentConfigError } from "@/lib/config/deployment-urls"

// The base is read from process.env at call time, so each case just sets env.
const ENV_KEYS = ["NEXT_PUBLIC_PORTAL_LOGIN_URL", "NEXT_PUBLIC_PORTAL_URL"] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe("portal-urls", () => {
  // No default host: a deployment that forgot the env must not mail its
  // customers links to somebody else's portal.
  it("throws from every helper when no portal URL is configured", () => {
    for (const build of [
      () => portalLoginUrl(),
      () => portalLoginUrl(null),
      () => portalRegisterUrl("a@b.com", "REF-1"),
      () => portalDocumentsUrl(),
      () => portalContinueUrl("a@b.com", "REF-1"),
    ]) {
      expect(build).toThrow(DeploymentConfigError)
    }
  })

  it("derives the base from NEXT_PUBLIC_PORTAL_LOGIN_URL when set", () => {
    process.env.NEXT_PUBLIC_PORTAL_LOGIN_URL = "https://portal.lender.example/portal/login"

    expect(portalLoginUrl()).toBe(
      "https://portal.lender.example/portal/login?callbackUrl=%2Fportal%2Fapplications",
    )
    expect(portalRegisterUrl("a@b.com", "REF-1")).toBe(
      "https://portal.lender.example/portal/register?email=a%40b.com&reference=REF-1",
    )
    expect(portalDocumentsUrl()).toBe("https://portal.lender.example/portal/documents")
    expect(portalContinueUrl("a@b.com", "REF-1")).toBe(
      "https://portal.lender.example/portal/continue?email=a%40b.com&reference=REF-1",
    )
  })

  it("falls back to NEXT_PUBLIC_PORTAL_URL and strips a trailing slash", () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = "https://portal-staging.example.com/"
    expect(portalDocumentsUrl()).toBe("https://portal-staging.example.com/portal/documents")
  })

  // Regression: the Docker build declares these ARGs with an empty-string
  // default, so an unset override reaches this module as a defined "".
  it("treats an empty-string NEXT_PUBLIC_PORTAL_LOGIN_URL as unset", () => {
    process.env.NEXT_PUBLIC_PORTAL_LOGIN_URL = ""
    expect(() => portalDocumentsUrl()).toThrow(DeploymentConfigError)
    process.env.NEXT_PUBLIC_PORTAL_URL = "https://portal.lender.example"
    expect(portalDocumentsUrl()).toBe("https://portal.lender.example/portal/documents")
  })

  it("treats an empty-string NEXT_PUBLIC_PORTAL_URL as unset", () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = ""
    expect(() => portalDocumentsUrl()).toThrow(DeploymentConfigError)
  })

  it("refuses a value that is not an absolute http(s) URL", () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = "portal.lender.example"
    expect(() => portalDocumentsUrl()).toThrow(DeploymentConfigError)
  })

  it("portalUrlOrNull: null when unconfigured, the URL when set, other errors propagate", () => {
    expect(portalUrlOrNull(() => portalDocumentsUrl())).toBeNull()
    process.env.NEXT_PUBLIC_PORTAL_URL = "https://portal.lender.example"
    expect(portalUrlOrNull(() => portalDocumentsUrl())).toBe("https://portal.lender.example/portal/documents")
    expect(() => portalUrlOrNull(() => { throw new Error("boom") })).toThrow("boom")
  })

  it("portalLoginUrl(null) returns the bare login URL with no callbackUrl param", () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = "https://portal.lender.example"
    expect(portalLoginUrl(null)).toBe("https://portal.lender.example/portal/login")
  })
})

// safePortalPath guards an open-redirect sink: its return value reaches both a
// 303 Location header (/portal/continue) and a client-side router.push
// (PortalRegisterForm). Every rejection below is an escape from our origin.
describe("safePortalPath", () => {
  it("accepts a same-origin portal deep link", async () => {
    expect(safePortalPath("/portal/agreement/clxtestapplication00000001"))
      .toBe("/portal/agreement/clxtestapplication00000001")
    expect(safePortalPath("/portal/applications")).toBe("/portal/applications")
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("returns null for %s", async (_label, input) => {
    expect(safePortalPath(input)).toBeNull()
  })

  it.each([
    // The one an attacker actually reaches for: a browser reads a leading `//`
    // as a HOST, so this leaves our origin entirely while looking like a path.
    ["protocol-relative", "//evil.example/x"],
    ["protocol-relative dressed as a portal host", "//portal.evil.example/"],
    ["absolute http", "http://evil.example/portal/x"],
    ["absolute https", "https://evil.example/portal/x"],
    // Browsers normalise `\` to `/`, so these become protocol-relative too.
    ["backslash escape", "/portal/\\evil.example"],
    ["backslash after prefix", "/portal\\evil.example"],
    ["scheme injection", "/portal/javascript:alert(1)"],
    ["a non-portal path", "/admin/users"],
    ["a prefix that only looks like /portal/", "/portalx/evil"],
    ["traversal back out of /portal", "/portal/../admin"],
    ["a query string", "/portal/agreement/x?y=1"],
    ["a fragment", "/portal/agreement/x#@evil.example"],
    ["a newline (header injection)", "/portal/x\nLocation: //evil.example"],
    ["leading whitespace", " /portal/x"],
  ])("rejects %s", async (_label, input) => {
    expect(safePortalPath(input)).toBeNull()
  })
})

describe("portalContinueUrl destination", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_PORTAL_URL = "https://portal.lender.example"
  })

  it("carries a safe destination through as `next`", async () => {
    const url = new URL(portalContinueUrl("a@b.com", "REF-1", "/portal/agreement/abc"))

    expect(url.origin).toBe("https://portal.lender.example")
    expect(url.searchParams.get("next")).toBe("/portal/agreement/abc")
    expect(url.searchParams.get("email")).toBe("a@b.com")
    expect(url.searchParams.get("reference")).toBe("REF-1")
  })

  it("drops an unsafe destination rather than emitting it", async () => {
    const url = new URL(portalContinueUrl("a@b.com", "REF-1", "//evil.example"))

    expect(url.searchParams.get("next")).toBeNull()
    expect(url.origin).toBe("https://portal.lender.example")
  })

  it("omits `next` entirely when no destination is given", async () => {
    expect(new URL(portalContinueUrl("a@b.com", "REF-1")).searchParams.has("next")).toBe(false)
  })
})
