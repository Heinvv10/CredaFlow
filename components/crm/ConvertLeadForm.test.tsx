import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TermField } from "./ConvertLeadForm"

describe("TermField", () => {
  it("renders a bounded integer input for a variable-term product", () => {
    const html = renderToStaticMarkup(
      <TermField product={{ minTermDays: 30, maxTermDays: 90 }} value="90" onChange={() => {}} />
    )
    expect(html).toContain("Term (days) — between 30 and 90")
    expect(html).toContain('min="30"')
    expect(html).toContain('max="90"')
    expect(html).toContain('step="1"')
    expect(html).toContain('value="90"')
    expect(html).not.toContain("Term must be")
  })

  it("shows an inline message when the term is out of range", () => {
    const html = renderToStaticMarkup(
      <TermField product={{ minTermDays: 30, maxTermDays: 90 }} value="120" onChange={() => {}} />
    )
    expect(html).toContain("Term must be a whole number between 30 and 90 days")
  })

  it("renders nothing for a fixed-term product", () => {
    const html = renderToStaticMarkup(
      <TermField product={{ minTermDays: 30, maxTermDays: 30 }} value="30" onChange={() => {}} />
    )
    expect(html).toBe("")
  })
})
