import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { passwordResetEmailHtml } from "./email"

describe("passwordResetEmailHtml", () => {
  // The brand is admin-entered DB text; it must not be able to inject markup.
  it("HTML-escapes the brand name everywhere it is printed", () => {
    const html = passwordResetEmailHtml({
      brandName: `Acme <img src=x onerror=alert(1)> & "Co"`,
      name: "Jane",
      resetUrl: "https://app.lender.example/reset-password?token=t",
      expiryMinutes: 60,
    })
    expect(html).not.toContain("<img")
    expect(html.match(/Acme &lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Co&quot;/g)).toHaveLength(3)
  })
})
