import { describe, expect, it } from "vitest"
import { websiteHome } from "./messages/en/website-home"
import { websiteContact } from "./messages/en/website-contact"

// Fair Score audit 2026-10-16: the public site sent consumers to the National
// Consumer Tribunal first. The route is the lender, then the Credit Ombud or
// the NCR; the Tribunal hears what the NCR refers.
describe("website complaints route", () => {
  it.each([
    ["home protection4", websiteHome.protection4],
    ["contact FAQ", websiteContact.faqComplaintA],
  ])("names the lender before the ombud/regulator, and those before the Tribunal (%s)", (_label, text) => {
    const lender = text.search(/\b(us|we)\b/)
    const ombud = text.indexOf("Credit Ombud")
    expect(lender).toBeGreaterThanOrEqual(0)
    expect(ombud).toBeGreaterThan(lender)
    const tribunal = text.indexOf("National Consumer Tribunal")
    if (tribunal !== -1) expect(tribunal).toBeGreaterThan(ombud)
  })

  // #147 review: policy and claim complaints go to the National Financial
  // Ombud; the FAIS Ombud hears advice and intermediary-service complaints.
  it.each([
    ["home protection4", websiteHome.protection4],
    ["contact FAQ", websiteContact.faqComplaintA],
  ])("sends insurance complaints to the right ombud (%s)", (_label, text) => {
    const clauses = text.split(/[.;]/)
    expect(clauses.find((c) => c.includes("National Financial Ombud"))).toMatch(/polic|claim/)
    expect(clauses.find((c) => c.includes("FAIS Ombud"))).toMatch(/advice/)
  })
})
