// The money boundary between the band form and the API.
//
// `numberOrNull` deliberately does NOT re-implement the money rules — those
// live in `parseDecimalAmount`, and a browser-side copy of "greater than zero
// once stored at 2 decimal places" would be a second implementation of a rule
// this repo has drift scars from duplicating. What it must get right is the one
// thing a second validator would otherwise hide: BLANK IS NOT ZERO.
//
// `Number("")` is 0. A blank premium passed through `Number` reaches the route
// as 0, and 0 is the single value that must never be storable — a rate card
// handing out cover for nothing. `parseDecimalAmount` would refuse it, but with
// "premiumAmount must be greater than zero once stored at 2 decimal places",
// which tells an operator who typed nothing that they typed a zero. Null
// instead produces "must be a finite number", which is what actually happened.
import { describe, expect, it } from "vitest"
import { numberOrNull, readApiError, toRands } from "./settings-insurance-config"

describe("numberOrNull", () => {
  it("does NOT turn a blank field into zero", () => {
    // The load-bearing case. `Number("")` is 0; this must not be.
    expect(numberOrNull("")).toBeNull()
    expect(numberOrNull("   ")).toBeNull()
    expect(Number("")).toBe(0)
  })

  it("passes a rand amount through unchanged, decimals and all", () => {
    expect(numberOrNull("45")).toBe(45)
    expect(numberOrNull("171.50")).toBe(171.5)
    expect(numberOrNull("0.01")).toBe(0.01)
  })

  it("passes zero through when it really was typed", () => {
    // A waiting period of zero days is a real insurer term. Refusing it here
    // would make a valid rule unenterable; the routes decide per field whether
    // zero is allowed (`allowZero`), and this is not the place to guess.
    expect(numberOrNull("0")).toBe(0)
  })

  it("tolerates surrounding whitespace", () => {
    expect(numberOrNull("  45.50  ")).toBe(45.5)
  })

  it("returns null for text, so the route names the field rather than storing NaN", () => {
    expect(numberOrNull("abc")).toBeNull()
    expect(numberOrNull("45,50")).toBeNull()
    expect(numberOrNull("R45")).toBeNull()
  })

  it("returns null for the non-finite values JSON cannot carry anyway", () => {
    expect(numberOrNull("Infinity")).toBeNull()
    expect(numberOrNull("-Infinity")).toBeNull()
    expect(numberOrNull("NaN")).toBeNull()
  })

  it("does not clamp a negative — the route refuses it, with its own words", () => {
    expect(numberOrNull("-45")).toBe(-45)
  })

  it("does not round finer-than-cent input away", () => {
    // Postgres would ROUND R0.001 to R0.00 rather than refuse it, which is why
    // `parseDecimalAmount` refuses it instead. Silently rounding here would
    // send R0.00 and defeat that.
    expect(numberOrNull("0.001")).toBe(0.001)
  })

  it("survives the JSON round trip a blank field actually takes", () => {
    // null is carried; NaN would arrive as null anyway, which is why null is
    // sent deliberately rather than relied on as an accident.
    expect(JSON.parse(JSON.stringify({ premiumAmount: numberOrNull("") }))).toEqual({
      premiumAmount: null,
    })
  })
})

describe("toRands", () => {
  it("converts the STRING a Decimal column arrives as", () => {
    // Prisma serialises Decimal(12,2) through toJSON, so these cross the wire
    // as strings, and `"10000" === 10000` is false — which is why a premium
    // comparison written against the raw JSON value silently never matches.
    // That last fact is the language's, not this module's: asserting it here
    // would be a tautology that passes whatever `toRands` does. The two
    // assertions below are the ones that can actually fail.
    expect(toRands("10000")).toBe(10000)
    expect(toRands("171.50")).toBe(171.5)
  })

  it("leaves a number alone", () => {
    expect(toRands(45.5)).toBe(45.5)
  })
})

describe("readApiError", () => {
  function response(body: unknown, status = 409): Response {
    return { status, json: async () => body } as Response
  }

  it("returns the route's own message verbatim", async () => {
    const refusal =
      "This band overlaps an existing band (ages 18-30) already covering MAIN_MEMBER over ages 25-40 at cover 10000"
    expect(await readApiError(response({ error: refusal }))).toBe(refusal)
  })

  it("falls back to the status when the body carries no error", async () => {
    expect(await readApiError(response({}, 500))).toContain("HTTP 500")
  })

  it("falls back when the error is blank rather than reporting an empty refusal", async () => {
    expect(await readApiError(response({ error: "   " }, 422))).toContain("HTTP 422")
  })

  it("falls back when the body will not parse at all", async () => {
    const broken = {
      status: 502,
      json: async () => {
        throw new Error("not json")
      },
    } as unknown as Response
    expect(await readApiError(broken)).toContain("HTTP 502")
  })
})
