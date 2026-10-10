import { describe, expect, it } from "vitest"
import { applyDemoHeaders, demoBannerText, demoCodeReveal, isDemoMode } from "./demo-mode"

describe("isDemoMode", () => {
  it("is on only for the string true", () => {
    expect(isDemoMode({ DEMO_MODE: "true" })).toBe(true)
    expect(isDemoMode({ DEMO_MODE: " TRUE " })).toBe(true)
  })
  it.each([undefined, "", "false", "1", "yes"])("is off for %j", (v) => {
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
  it("returns the code only for the exact string true", () => {
    expect(demoCodeReveal("123456", { DEMO_MODE: "true" })).toEqual({ demoCode: "123456" })
  })
  it.each([undefined, "", "false", "TRUE", "TRUE ", " true", "1", "yes"])("returns nothing for %j", (v) => {
    expect(demoCodeReveal("123456", { DEMO_MODE: v })).toEqual({})
  })
})
