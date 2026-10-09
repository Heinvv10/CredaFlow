import { describe, expect, it } from "vitest"
import { buildQuickQuoteOptions } from "./quickquote-options"

describe("buildQuickQuoteOptions", () => {
  const CONFIG = {
    ebc: "ebc-value",
    elead: "elead-value",
    brokerContactEmail: "insurance@acme-lending.example",
    brokerName: "ACME LENDING (PTY) LTD",
  }

  // Asserted as a whole object, not field by field. A dropped field does not
  // throw — FSP's script silently substitutes its own default, and for
  // leadEmail that default is itteam@fspsolutions.com.
  it("forwards every field FSP's plugin needs", () => {
    expect(buildQuickQuoteOptions(CONFIG, "motor")).toEqual({
      ebc: "ebc-value",
      elead: "elead-value",
      brokerContactEmail: "insurance@acme-lending.example",
      brokerName: "ACME LENDING (PTY) LTD",
      thirdparty: true,
      initialView: "motor",
    })
  })

  // Left at FSP's default: sendQuoteLead fires at _SaveQuote, before the
  // contact form that captures name/email/cell exists, so it would produce a
  // lead with nobody to call. Pinned out so it is not re-added by accident.
  it("does not enable sendQuoteLead", () => {
    expect("sendQuoteLead" in buildQuickQuoteOptions(CONFIG, "motor")).toBe(false)
  })

  // Without thirdparty the lead routes to FSP's own mailbox, not elead.
  it("always declares the third-party intermediary relationship", () => {
    expect(buildQuickQuoteOptions(CONFIG, "home").thirdparty).toBe(true)
  })

  it.each(["motor", "home", "building"] as const)("passes the %s view through", (view) => {
    expect(buildQuickQuoteOptions(CONFIG, view).initialView).toBe(view)
  })

  it("does not mutate the config it is given", () => {
    const config = { ...CONFIG }
    buildQuickQuoteOptions(config, "motor")
    expect(config).toEqual(CONFIG)
  })
})
