import { describe, expect, it } from "vitest"

import {
  PORTAL_INTENTS,
  WEBSITE_INTENTS,
  waHref,
  type SupportIntent,
} from "@/lib/support/whatsapp-intents"

const E164 = "+27110000000"

describe("waHref", () => {
  it("builds a wa.me deep-link with bare digits and the message URL-encoded", () => {
    expect(waHref(E164, "Hi, I'd like to apply for a loan.")).toBe(
      "https://wa.me/27110000000?text=Hi%2C%20I'd%20like%20to%20apply%20for%20a%20loan.",
    )
  })

  it("strips the leading + from the E.164 number", () => {
    expect(waHref(E164, "x")).toContain("wa.me/27110000000?")
    expect(waHref(E164, "x")).not.toContain("+")
  })

  it("encodes characters that would otherwise break the query string", () => {
    expect(waHref(E164, "a&b=c?d")).toBe("https://wa.me/27110000000?text=a%26b%3Dc%3Fd")
  })
})

describe("intent lists", () => {
  const lists: Array<[string, readonly SupportIntent[]]> = [
    ["WEBSITE_INTENTS", WEBSITE_INTENTS],
    ["PORTAL_INTENTS", PORTAL_INTENTS],
  ]

  // Both lists are pinned as literals rather than checked for shape. A
  // pre-filled message is copy the CLIENT appears to have written, so its exact
  // wording is a factual claim by a registered credit provider: it must never
  // promise a response time, product availability, approval, or any outcome.
  // Asserting only that the fields are non-empty let six of these eight
  // messages be rewritten to anything at all with the suite still green.
  it("WEBSITE_INTENTS is exactly the approved website copy", () => {
    expect(WEBSITE_INTENTS).toEqual([
      {
        id: "apply",
        label: "Apply for a loan",
        message: "Hi, I'd like to apply for a loan.",
      },
      {
        id: "rates",
        label: "Rates and repayments",
        message: "Hi, I have a question about rates and repayments.",
      },
      {
        id: "insurance",
        label: "Insurance enquiry",
        message: "Hi, I'd like to know more about your insurance cover.",
      },
      {
        id: "complaint",
        label: "Log a complaint",
        message: "Hi, I'd like to log a complaint.",
      },
    ])
  })

  it("PORTAL_INTENTS is exactly the approved portal copy", () => {
    expect(PORTAL_INTENTS).toEqual([
      {
        id: "account",
        label: "Help with my account",
        message: "Hi, I need help with my loan account.",
      },
      {
        id: "payment",
        label: "Payment or arrangement",
        message: "Hi, I'd like to discuss a payment or arrangement.",
      },
      {
        id: "banking",
        label: "Update banking details",
        message: "Hi, I need to update my banking details.",
      },
      {
        id: "complaint",
        label: "Log a complaint",
        message: "Hi, I'd like to log a complaint.",
      },
    ])
  })

  // The pins above already cover today's eight. This guard is what catches a
  // NINTH intent added later: whoever adds it must update the pin, and this
  // rule then independently refuses copy that makes a promise.
  const PROMISE_WORDS = /\b(within \d+|guarantee|approved?|instant|immediately|24 hours)\b/i

  for (const [name, list] of lists) {
    it(`${name} promises no response time, approval or outcome`, () => {
      for (const intent of list) {
        expect(intent.message).not.toMatch(PROMISE_WORDS)
        expect(intent.label).not.toMatch(PROMISE_WORDS)
      }
    })

    it(`${name} has unique ids so analytics events are distinguishable`, () => {
      const ids = list.map((intent) => intent.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  }

  it("offers a complaint route on both surfaces", () => {
    expect(WEBSITE_INTENTS.some((i) => i.id === "complaint")).toBe(true)
    expect(PORTAL_INTENTS.some((i) => i.id === "complaint")).toBe(true)
  })
})
