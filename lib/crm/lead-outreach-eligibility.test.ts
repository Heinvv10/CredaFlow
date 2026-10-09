import { describe, it, expect } from "vitest"
import { leadOutreachEligibility } from "./lead-outreach-eligibility"

// These cases are the compliance basis of the whole outreach feature, not a
// UI nicety: the templates are classified SERVICE on the claim that the
// recipient asked us for a loan, and this predicate is the only code that
// checks that claim. Each fixture below mirrors a REAL lead-creation path.

describe("leadOutreachEligibility — who actually asked us for a loan", () => {
  it("allows a lead who applied for a specific amount (app/api/website/apply)", () => {
    expect(leadOutreachEligibility({ status: "NEW", requestedAmount: 500_000 })).toEqual({ ok: true })
  })

  it("refuses a website contact-form enquiry — no amount, so no loan enquiry to service", () => {
    // app/api/website/contact: source WEBSITE, tags ["contact-form"], never
    // sets requestedAmount. Telling this person "your loan application is
    // still open" is false, and offering them credit unsolicited is s.69
    // direct marketing they hold no consent for.
    const r = leadOutreachEligibility({ status: "NEW", requestedAmount: null })
    expect(r).toMatchObject({ ok: false, reason: "NOT_A_LOAN_ENQUIRY" })
  })

  it("refuses a staff-typed MANUAL lead with no amount captured", () => {
    // app/api/crm/leads: source defaults to MANUAL, requestedAmount optional.
    // Fails closed — capture the amount and it becomes eligible.
    expect(leadOutreachEligibility({ status: "CONTACTED", requestedAmount: null }).ok).toBe(false)
  })

  it("allows the same staff-typed lead once the amount is captured", () => {
    expect(leadOutreachEligibility({ status: "CONTACTED", requestedAmount: 250_000 })).toEqual({ ok: true })
  })

  it("fails closed on undefined/NaN, not just null — the last line of defence", () => {
    // `x === null || x <= 0` failed OPEN here: `<= 0` is false for NaN, so an
    // undefined field sailed through. Unreachable today (the send path always
    // selects requestedAmount) but the status axis fails closed and this one
    // must too. Verified by a reviewer running it, not by reading it.
    const cases = [undefined, NaN, "abc"] as unknown as Array<number | null>
    for (const v of cases) {
      expect(leadOutreachEligibility({ status: "NEW", requestedAmount: v }).ok).toBe(false)
    }
  })

  it("refuses a zero or negative requested amount — asking for R0 is not a credit enquiry", () => {
    // The predicate's contract is "a recorded fact that this person asked us
    // for CREDIT". R0 is not that. No public form can produce it (apply
    // coerces 0 to null) but the staff PATCH writes the value unvalidated.
    expect(leadOutreachEligibility({ status: "NEW", requestedAmount: 0 }).ok).toBe(false)
    expect(leadOutreachEligibility({ status: "NEW", requestedAmount: -1 }).ok).toBe(false)
  })
})

describe("leadOutreachEligibility — status is an allow-list, so it fails closed", () => {
  it("refuses a status that is not in the allow-list", () => {
    // The real risk: a deny-list of {CONVERTED, LOST} silently enrols every
    // status added later. The day someone adds ARCHIVED / DO_NOT_CONTACT /
    // DECEASED, those leads must NOT start receiving "your application is
    // still open".
    for (const status of ["ARCHIVED", "DO_NOT_CONTACT", "DECEASED", "", "new"]) {
      expect(leadOutreachEligibility({ status, requestedAmount: 500_000 }).ok).toBe(false)
    }
  })
})

describe("leadOutreachEligibility — closed leads", () => {
  it.each(["CONVERTED", "LOST"])("refuses a %s lead even with an amount on file", (status) => {
    // The copy says "your loan application is still open" — false here.
    const r = leadOutreachEligibility({ status, requestedAmount: 500_000 })
    expect(r).toMatchObject({ ok: false, reason: "LEAD_CLOSED" })
  })

  it("reports CLOSED ahead of NOT_A_LOAN_ENQUIRY when both apply", () => {
    // A converted lead with no amount is closed first — the more accurate
    // thing to tell the agent.
    const r = leadOutreachEligibility({ status: "CONVERTED", requestedAmount: null })
    expect(r).toMatchObject({ ok: false, reason: "LEAD_CLOSED" })
  })

  it.each(["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT"])(
    "allows open status %s when an amount is on file",
    (status) => {
      expect(leadOutreachEligibility({ status, requestedAmount: 500_000 })).toEqual({ ok: true })
    }
  )

  it("gives the agent an actionable reason, not just a refusal", () => {
    const closed = leadOutreachEligibility({ status: "LOST", requestedAmount: 1 })
    const noEnquiry = leadOutreachEligibility({ status: "NEW", requestedAmount: null })
    expect(closed.ok).toBe(false)
    expect(noEnquiry.ok).toBe(false)
    if (!closed.ok) expect(closed.detail.length).toBeGreaterThan(20)
    if (!noEnquiry.ok) expect(noEnquiry.detail).toContain("amount")
  })
})
