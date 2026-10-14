import { describe, expect, it } from "vitest"
import { isReviewCurrent, parseLanguageReviews, parseLanguageUpdate, servableLocales, withAcknowledgements } from "./language-reviews"
import { catalogueHash } from "./catalogue-hash"

const reviewOf = (l: "af" | "zu" | "xh") =>
  ({ reviewer: "N. Reviewer", acknowledgedAt: "2026-10-14T08:00:00.000Z", acknowledgedById: "u1", acknowledgedByEmail: "root@lender.example", catalogueHash: catalogueHash(l) })
const review = reviewOf("af")
const staleAf = { ...review, catalogueHash: "hash-of-an-older-af-text" }

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

  it("refuses a language whose stored review covers an older text, and accepts a fresh acknowledgement", () => {
    expect(parseLanguageUpdate({ enabledLanguages: ["en", "af"], acknowledgements: {} }, { af: staleAf }))
      .toEqual({ ok: false, error: "The text changed since its review; acknowledge a new native-speaker review for: af" })
    expect(parseLanguageUpdate({ enabledLanguages: ["en", "af"], acknowledgements: { af: { reviewer: "B", confirmed: true } } }, { af: staleAf }).ok).toBe(true)
    // Switching it off needs nothing.
    expect(parseLanguageUpdate({ enabledLanguages: ["en"], acknowledgements: {} }, { af: staleAf }).ok).toBe(true)
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

  it("stops serving a language once its text changes after the review", () => {
    expect(servableLocales(["en", "af"], { af: staleAf })).toEqual(["en"])
    const { catalogueHash: _omit, ...legacy } = review
    expect(servableLocales(["en", "af"], { af: legacy })).toEqual(["en"])
    expect(isReviewCurrent("af", review)).toBe(true)
    expect(isReviewCurrent("zu", review)).toBe(false)
  })
})

describe("catalogueHash", () => {
  it("is a stable sha256 per language and differs between languages", () => {
    expect(catalogueHash("af")).toMatch(/^[0-9a-f]{64}$/)
    expect(catalogueHash("af")).toBe(catalogueHash("af"))
    expect(new Set([catalogueHash("af"), catalogueHash("zu"), catalogueHash("xh")]).size).toBe(3)
  })
})

describe("withAcknowledgements", () => {
  it("records who acknowledged and when, keeping earlier reviews", () => {
    const next = withAcknowledgements({ af: review }, { zu: "Thandeka" }, { id: "u2", email: "sa@lender.example" }, new Date("2026-10-15T09:00:00Z"))
    expect(parseLanguageReviews(next)).toEqual({
      af: review,
      zu: { reviewer: "Thandeka", acknowledgedAt: "2026-10-15T09:00:00.000Z", acknowledgedById: "u2", acknowledgedByEmail: "sa@lender.example", catalogueHash: catalogueHash("zu") },
    })
  })
})
