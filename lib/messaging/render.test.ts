import { describe, it, expect } from "vitest"
import { renderTemplate } from "./render"

const baseTemplate = {
  id: "t1",
  tenantId: "tn1",
  key: "test_template",
  category: "TRANSACTIONAL" as const,
  purposeRequired: null,
  statutoryOverride: false,
  subject: "Hi {{firstName}}",
  body: "Hello {{firstName}}, your loan {{loanId}} is ready.",
  bodyTemplate: null as string | null,
}

describe("renderTemplate", () => {
  it("substitutes {{var}} placeholders in subject and body", () => {
    const r = renderTemplate(baseTemplate, { firstName: "Sipho", loanId: "L-123" })
    expect(r.subject).toBe("Hi Sipho")
    expect(r.text).toBe("Hello Sipho, your loan L-123 is ready.")
  })

  it("throws when a referenced var is missing from vars", () => {
    expect(() => renderTemplate(baseTemplate, { firstName: "Sipho" }))
      .toThrow(/missing.*loanId/i)
  })

  it("returns the expected shape: {subject, html, text}", () => {
    const r = renderTemplate(baseTemplate, { firstName: "S", loanId: "L" })
    expect(r).toHaveProperty("subject")
    expect(r).toHaveProperty("html")
    expect(r).toHaveProperty("text")
  })
})
