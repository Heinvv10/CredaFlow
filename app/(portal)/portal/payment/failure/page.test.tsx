import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("@/lib/config/identity", () => ({
  getLenderIdentity: vi.fn(async () => ({
    publicEmail: "hello@acme-lending.example",
    publicPhone: "+27 11 000 0000",
  })),
}))

import PaymentFailurePage from "./page"

// The page is reached from a browser redirect whose status is the browser's
// claim, and Stitch may still settle the payment by webhook. It must not tell
// the payer nothing was deducted: that invites a second payment.
describe("portal payment failure page", () => {
  it("does not claim no money was taken, and warns against paying twice", async () => {
    const html = renderToStaticMarkup(await PaymentFailurePage())
    expect(html).not.toMatch(/no funds have been deducted/i)
    expect(html).toContain(
      "We couldn&#x27;t confirm your payment. If money left your account, it will be allocated to your loan once your bank confirms it — please don&#x27;t pay again until you&#x27;ve checked your bank statement.",
    )
  })

  it("says the payment is not confirmed, not that it failed", async () => {
    const html = renderToStaticMarkup(await PaymentFailurePage())
    expect(html).toContain(">Payment not confirmed</h1>")
    expect(html).not.toMatch(/Payment Failed|Try Again/)
  })

  it("leads back to the loans, with paying again only as a secondary link after the text", async () => {
    const html = renderToStaticMarkup(await PaymentFailurePage())
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]])
    expect(links[0]).toEqual(["/portal/loans", "Back to my loans"])
    expect(links).toContainEqual(["/portal/payment", "Make a new payment"])
    const pay = html.indexOf('href="/portal/payment"')
    expect(pay).toBeGreaterThan(html.indexOf("checked your bank statement"))
    expect(pay).toBeGreaterThan(html.indexOf('href="/portal/loans"'))
  })

  it("keeps the support contact", async () => {
    const html = renderToStaticMarkup(await PaymentFailurePage())
    expect(html).toContain('href="mailto:hello@acme-lending.example"')
    expect(html).toContain("+27 11 000 0000")
  })
})
