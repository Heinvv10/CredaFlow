import { describe, expect, it } from "vitest"
import { negotiateLocale, normaliseEnabledLocales, parseAcceptLanguage } from "./locales"

describe("normaliseEnabledLocales", () => {
  it("always includes English, drops unknown codes and duplicates, keeps a stable order", () => {
    expect(normaliseEnabledLocales(null)).toEqual(["en"])
    expect(normaliseEnabledLocales(["xh", "fr", "af", "af"])).toEqual(["en", "af", "xh"])
  })
})

describe("parseAcceptLanguage", () => {
  it("orders by q, ignores regions and refused ranges", () => {
    expect(parseAcceptLanguage("en-ZA,en;q=0.9,zu;q=0.95,af;q=0")).toEqual(["en", "zu"])
    expect(parseAcceptLanguage("xh-ZA")).toEqual(["xh"])
    expect(parseAcceptLanguage(null)).toEqual([])
  })
})

describe("negotiateLocale", () => {
  const enabled = ["en", "af", "zu"] as const

  it("cookie, then profile, then browser, then English", () => {
    expect(negotiateLocale({ enabled, cookie: "af", profile: "zu", acceptLanguage: "zu" })).toBe("af")
    expect(negotiateLocale({ enabled, cookie: null, profile: "zu", acceptLanguage: "af" })).toBe("zu")
    expect(negotiateLocale({ enabled, acceptLanguage: "fr, af;q=0.5" })).toBe("af")
    expect(negotiateLocale({ enabled })).toBe("en")
  })

  it("skips a language the tenant has not enabled", () => {
    expect(negotiateLocale({ enabled, cookie: "xh", profile: "xh", acceptLanguage: "xh" })).toBe("en")
    expect(negotiateLocale({ enabled: ["en"], cookie: "af" })).toBe("en")
  })
})
