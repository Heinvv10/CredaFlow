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

  it("keeps the support contact", async () => {
    const html = renderToStaticMarkup(await PaymentFailurePage())
    expect(html).toContain('href="mailto:hello@acme-lending.example"')
    expect(html).toContain("+27 11 000 0000")
  })
})
