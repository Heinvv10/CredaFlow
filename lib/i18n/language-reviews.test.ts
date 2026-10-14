import { describe, expect, it } from "vitest"
import { parseLanguageReviews, parseLanguageUpdate, servableLocales, withAcknowledgements } from "./language-reviews"

const review = { reviewer: "N. Reviewer", acknowledgedAt: "2026-10-14T08:00:00.000Z", acknowledgedById: "u1", acknowledgedByEmail: "root@lender.example" }

describe("parseLanguageUpdate", () => {
  it("refuses a non-English language with no stored review and no acknowledgement", () => {
    expect(parseLanguageUpdate({ enabledLanguages: ["en", "zu"], acknowledgements: undefined }, {}))
      .toEqual({ ok: false, error: "Acknowledge a native-speaker review before enabling: zu" })
  })

  it("accepts it with a confirmed, named acknowledgement", () => {
    const r = parseLanguageUpdate({ enabledLanguages: ["zu", "en"], acknowledgements: { zu: { reviewer: " Thandeka ", confirmed: true } } }, {})
    expect(r).toEqual({ ok: true, update: { enabled: ["en", "zu"], acknowledgements: { zu: "Thandeka" } } })
  })

  it("accepts an already reviewed language without a new acknowledgement", () => {
    expect(parseLanguageUpdate({ enabledLanguages: ["en", "af"], acknowledgements: {} }, { af: review }).ok).toBe(true)
  })

  it.each([
    [{ zu: { reviewer: "X", confirmed: false } }],
    [{ zu: { reviewer: "   ", confirmed: true } }],
    [{ zu: { confirmed: true } }],
    [{ en: { reviewer: "X", confirmed: true } }],
    [{ fr: { reviewer: "X", confirmed: true } }],
    [["zu"]],
  ])("refuses a malformed acknowledgement %j", (acknowledgements) => {
    expect(parseLanguageUpdate({ enabledLanguages: ["en", "zu"], acknowledgements }, {}).ok).toBe(false)
  })

  it("refuses a list without English or with unknown codes", () => {
    expect(parseLanguageUpdate({ enabledLanguages: ["af"], acknowledgements: {} }, { af: review }).ok).toBe(false)
    expect(parseLanguageUpdate({ enabledLanguages: ["en", "fr"], acknowledgements: {} }, {}).ok).toBe(false)
    expect(parseLanguageUpdate({ enabledLanguages: "en,af", acknowledgements: {} }, {}).ok).toBe(false)
  })

  it("allows switching a language off with no acknowledgement", () => {
    expect(parseLanguageUpdate({ enabledLanguages: ["en"], acknowledgements: {} }, {})).toEqual({ ok: true, update: { enabled: ["en"], acknowledgements: {} } })
  })
})

describe("servableLocales", () => {
  it("serves only enabled languages that carry a review record", () => {
    expect(servableLocales(["en", "af", "zu"], { af: review })).toEqual(["en", "af"])
    expect(servableLocales(["en", "af"], { af: { reviewer: "", acknowledgedAt: "x" } })).toEqual(["en"])
    expect(servableLocales(["en", "xh"], null)).toEqual(["en"])
  })
})

describe("withAcknowledgements", () => {
  it("records who acknowledged and when, keeping earlier reviews", () => {
    const next = withAcknowledgements({ af: review }, { zu: "Thandeka" }, { id: "u2", email: "sa@lender.example" }, new Date("2026-10-15T09:00:00Z"))
    expect(parseLanguageReviews(next)).toEqual({
      af: review,
      zu: { reviewer: "Thandeka", acknowledgedAt: "2026-10-15T09:00:00.000Z", acknowledgedById: "u2", acknowledgedByEmail: "sa@lender.example" },
    })
  })
})
