import { describe, it, expect } from "vitest"
import { REDACTED_BODY_PLACEHOLDER, storedBodyFor } from "./redaction"

const rendered = {
  subject: "Your activation code",
  text: "Your code is 483920.",
  html: "<p>Your code is <b>483920</b>.</p>",
}

describe("storedBodyFor", () => {
  it("returns the rendered body unchanged for an ordinary template", () => {
    expect(storedBodyFor({ redactStoredBody: false }, rendered)).toEqual(rendered)
  })

  it("replaces both bodies with the placeholder when the template is flagged", () => {
    const stored = storedBodyFor({ redactStoredBody: true }, rendered)
    expect(stored.text).toBe(REDACTED_BODY_PLACEHOLDER)
    expect(stored.html).toBe(REDACTED_BODY_PLACEHOLDER)
  })

  it("leaves no trace of the secret in the stored body", () => {
    const stored = storedBodyFor({ redactStoredBody: true }, rendered)
    expect(JSON.stringify(stored)).not.toContain("483920")
  })

  it("keeps the subject so the timeline row stays identifiable", () => {
    expect(storedBodyFor({ redactStoredBody: true }, rendered).subject)
      .toBe("Your activation code")
  })

  it("preserves a null html body rather than inventing one", () => {
    const stored = storedBodyFor({ redactStoredBody: true }, { ...rendered, html: null })
    expect(stored.html).toBeNull()
  })
})
