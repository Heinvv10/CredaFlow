import { describe, expect, it } from "vitest"
import { applyDemoHeaders, demoBannerText, demoCodeReveal, isDemoMode } from "./demo-mode"

describe("isDemoMode", () => {
  it("is on only for the exact string true", () => {
    expect(isDemoMode({ DEMO_MODE: "true" })).toBe(true)
  })
  it.each([undefined, "", "false", "1", "yes", "TRUE", "True", " true", "true ", " TRUE "])("is off for %j", (v) => {
    expect(isDemoMode({ DEMO_MODE: v })).toBe(false)
  })
})

describe("applyDemoHeaders", () => {
  it("adds X-Robots-Tag when demo mode is on", () => {
    const res = applyDemoHeaders(new Response("x"), { DEMO_MODE: "true" })
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow")
  })
  it("adds nothing when unset", () => {
    const res = applyDemoHeaders(new Response("x"), {})
    expect(res.headers.has("X-Robots-Tag")).toBe(false)
  })
})

describe("demoBannerText", () => {
  it("names the tenant brand when known", () => {
    expect(demoBannerText("Acme Lending")).toBe(
      "Demo environment — Acme Lending is a fictional lender. Do not enter real personal information.",
    )
  })
  it("falls back to generic wording", () => {
    expect(demoBannerText(null)).toContain("fictional lender")
    expect(demoBannerText(null)).not.toContain("null")
  })
})

describe("demoCodeReveal", () => {
  const ON = { DEMO_MODE: "true" }

  it("returns the code for a .invalid recipient when demo mode is exactly true", () => {
    expect(demoCodeReveal("123456", "thabo@acme-lending.invalid", ON)).toEqual({ demoCode: "123456" })
  })
  it("normalises the recipient before checking the domain", () => {
    expect(demoCodeReveal("123456", "  Thabo@Acme-Lending.INVALID ", ON)).toEqual({ demoCode: "123456" })
  })
  it("accepts a plus-tagged dotted local part on a hyphenated .invalid domain", () => {
    expect(demoCodeReveal("123456", "thandi.m+1@acme-lending.invalid", ON)).toEqual({ demoCode: "123456" })
  })
  it("accepts a .invalid recipient with trailing whitespace once trimmed", () => {
    expect(demoCodeReveal("123456", "x@y.invalid ", ON)).toEqual({ demoCode: "123456" })
  })
  it.each([undefined, "", "false", "TRUE", "TRUE ", " true", "1", "yes"])(
    "returns nothing for DEMO_MODE=%j, even for a .invalid recipient",
    (v) => {
      expect(demoCodeReveal("123456", "thabo@acme-lending.invalid", { DEMO_MODE: v })).toEqual({})
    },
  )
  it.each([
    "someone@example.com",
    "someone@gmail.com",
    "someone@invalid.co.za",
    "someone@example.invalid.com",
    "someone@example.invalid.",
    "invalid",
    ".invalid",
    "real@gmail.com, x@y.invalid",
    "real@gmail.com;x@y.invalid",
    "real@gmail.com,x@y.invalid",
    "a@b@c.invalid",
    "x y@z.invalid",
    "<real@gmail.com>x.invalid",
    "\"a b\"@x.invalid",
  ])("returns nothing in demo mode for a deliverable or malformed recipient %j", (email) => {
    expect(demoCodeReveal("123456", email, ON)).toEqual({})
  })
})
