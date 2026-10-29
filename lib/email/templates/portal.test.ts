import { describe, it, expect } from "vitest"
import { applicationDeclinedEmail, identityConflictNoticeEmail, paymentDueReminderEmail } from "./portal"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"

const identity = parseLenderIdentity(VALID_LENDER_COLUMNS)

describe("identityConflictNoticeEmail", () => {
  const html = identityConflictNoticeEmail(identity, {
    clientName: "Thandi",
    portalUrl: "https://portal.lender.example/portal/continue?email=x&reference=CLI-1",
    maskedOtherLabel: "email address",
    maskedOtherValue: "d****e@lender.example",
  })

  it("greets the client by name", () => {
    expect(html).toContain("Thandi")
  })
  it("renders the portal CTA linking to the provided portalUrl", () => {
    expect(html).toContain("https://portal.lender.example/portal/continue?email=x&reference=CLI-1")
    expect(html).toContain("Continue in the portal")
  })
  it("shows the masked identifier and its label, never a raw value", () => {
    expect(html).toContain("email address")
    expect(html).toContain("d****e@lender.example")
  })
  it("reassures that nothing was changed (security framing)", () => {
    expect(html.toLowerCase()).toContain("did not change")
  })
})

describe("identityConflictNoticeEmail — output encoding", () => {
  it("escapes HTML metacharacters in the masked value and client name (no raw tag injected)", () => {
    const html = identityConflictNoticeEmail(identity, {
      clientName: "<b>Eve",
      portalUrl: "https://portal.lender.example/portal/continue?email=x&reference=CLI-1",
      maskedOtherLabel: "email address",
      maskedOtherValue: "<img src=x>@evil.com",
    })
    expect(html).toContain("&lt;img src=x&gt;@evil.com")
    expect(html).not.toContain("<img src=x>")
    expect(html).toContain("&lt;b&gt;Eve")
    expect(html).not.toContain("<b>Eve")
  })
})

describe("paymentDueReminderEmail wording", () => {
  it("asks for payment by the due date without threatening charges", () => {
    const html = paymentDueReminderEmail(identity, "Thabo Nkosi", 150_000, "2026-10-01", "LN-0099")
    expect(html).toContain("Please make your payment by the due date. You can make an EFT payment to:")
    expect(html).not.toMatch(/avoid further|default interest|late payment fee/i)
  })
})

describe("tenant identity in the shared layout", () => {
  it("prints the tenant's name, NCR number, email and legal name — nothing inherited", () => {
    const html = paymentDueReminderEmail(identity, "Thabo", 150_000, "2026-10-01", "REF-1")
    expect(html).toContain("Acme Lending")
    expect(html).toContain("NCRCP99999")
    expect(html).toContain("mailto:hello@acme-lending.example")
    expect(html).toContain("Acme Lending (Pty) Ltd")
    expectNoOtherLender(html)
  })
})

describe("applicationDeclinedEmail: the automated-decision notice", () => {
  it("is unchanged without a notice", () => {
    expect(applicationDeclinedEmail(identity, "Thandi", "APP-1", "Affordability")).not.toContain("automated")
  })

  it("adds the lender's approved wording, escaped, when there is one", () => {
    const html = applicationDeclinedEmail(identity, "Thandi", "APP-1", "Affordability", "This decision was made by an automated process. <b>Ask</b> for a review.")
    expect(html).toContain("This decision was made by an automated process. &lt;b&gt;Ask&lt;/b&gt; for a review.")
    expect(html).not.toContain("<b>Ask</b>")
  })
})
