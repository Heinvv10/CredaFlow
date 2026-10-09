import { describe, it, expect } from "vitest"
import { htmlToPlainText } from "./html-to-text"
import { applicationSubmittedEmail } from "./templates/portal"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

describe("htmlToPlainText", () => {
  it("returns empty for empty input", () => {
    expect(htmlToPlainText("")).toBe("")
  })

  it("strips tags and keeps text", () => {
    expect(htmlToPlainText("<p>Hello <strong>world</strong></p>")).toBe("Hello world")
  })

  it("renders links as 'text (url)'", () => {
    expect(htmlToPlainText('<a href="https://x.com/y">Click here</a>')).toBe("Click here (https://x.com/y)")
  })

  it("collapses a link whose text equals its href to just the url", () => {
    expect(htmlToPlainText('<a href="https://x.com">https://x.com</a>')).toBe("https://x.com")
  })

  it("renders mailto links as just the address, not 'addr (mailto:addr)'", () => {
    expect(htmlToPlainText('<a href="mailto:info@x.com">info@x.com</a>')).toBe("info@x.com")
    expect(htmlToPlainText('<a href="mailto:info@x.com">Email us</a>')).toBe("Email us (info@x.com)")
  })

  it("decodes named and numeric entities", () => {
    expect(htmlToPlainText("We&rsquo;ve &amp; more &middot; a&#8217;b &#x2014; c")).toBe("We’ve & more · a’b — c")
  })

  it("separates adjacent table cells on a single source line (no label/value fusion)", () => {
    // Regression guard: single-line rows like section129Html's ref-block used to
    // fuse into "Account referenceLN-1".
    expect(htmlToPlainText("<tr><td>Account reference</td><td>LN-1</td></tr>")).toBe("Account reference LN-1")
  })

  it("turns block boundaries and <br> into newlines", () => {
    expect(htmlToPlainText("<p>a</p><p>b</p>")).toBe("a\nb")
    expect(htmlToPlainText("a<br>b<br/>c")).toBe("a\nb\nc")
  })

  it("drops <style>/<script> content entirely", () => {
    expect(htmlToPlainText("<style>.x{color:red}</style><p>hi</p>")).toBe("hi")
    expect(htmlToPlainText('<script>alert(1)</script><p>hi</p>')).toBe("hi")
  })

  it("collapses runs of whitespace and blank lines", () => {
    expect(htmlToPlainText("<p>a   b</p>\n\n\n<p>c</p>")).toBe("a b\n\nc")
  })

  it("produces a readable text fallback for the real application-received email", () => {
    const html = applicationSubmittedEmail(
      parseLenderIdentity(VALID_LENDER_COLUMNS),
      "Thabo",
      "WEB-TEST-1",
      "Personal Loan",
      500000,
      "https://portal.lender.example/portal/register?email=a%40b.com&reference=WEB-TEST-1",
    )
    const text = htmlToPlainText(html)
    // No markup leaks through.
    expect(text).not.toMatch(/<[a-z/]/i)
    // Key content survives.
    expect(text).toContain("We’ve received your application")
    expect(text).toContain("Dear Thabo")
    expect(text).toContain("WEB-TEST-1")
    expect(text).toContain("Personal Loan")
    expect(text).toContain("R 5,000.00")
    // The CTA link target is usable in plain text.
    expect(text).toContain("Track my application (https://portal.lender.example/portal/register?email=a%40b.com&reference=WEB-TEST-1)")
  })
})
