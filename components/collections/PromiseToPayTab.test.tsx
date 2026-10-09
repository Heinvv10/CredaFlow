import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PromiseToPayTab } from "./CollectionDetailTabs"

// This is the surface a collections officer actually reads. An earlier fix
// moved the identical rule in `lib/collections/promiseToPay.ts`, which has no
// production callers — so the badge stayed wrong while the suite stayed green.
// These tests exist so that cannot happen again.

const PROMISE = {
  id: "note-1",
  type: "promise_to_pay",
  createdBy: "agent@example.test",
  createdAt: "2026-07-01T09:00:00.000Z",
  note: JSON.stringify({ promiseAmount: 100_000, promiseDate: "2026-07-05" }),
}

function payment(overrides: { receivedAt: string; createdAt: string }) {
  return {
    id: "payment-1",
    amount: 100_000,
    paymentMethod: "CASH",
    reference: null,
    ...overrides,
  }
}

describe("PromiseToPayTab", () => {
  // The Broken badge is gated on `promiseDate < new Date()`, so these cases
  // depend on the clock. Frozen well after the promise date so the assertions
  // describe the rule rather than the day the suite happens to run.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-20T09:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("reads a promise as Kept when the money ARRIVED in the window", () => {
    // Paid on the promised day, captured on the 20th — long past the 3-day
    // grace. Bucketing on capture time renders "Broken" against a client who
    // paid on time, and that feeds escalation toward a s129 notice.
    const html = renderToStaticMarkup(
      <PromiseToPayTab
        promises={[PROMISE]}
        payments={[payment({
          receivedAt: "2026-07-05T09:00:00.000Z",
          createdAt: "2026-07-20T09:00:00.000Z",
        })]}
      />,
    )

    expect(html).toContain("Kept")
    expect(html).not.toContain("Broken")
  })

  it("still reads Broken when no money arrived in the window at all", () => {
    // The guard must not become "always Kept" — that would silently stop
    // legitimate arrears work.
    const html = renderToStaticMarkup(
      <PromiseToPayTab
        promises={[PROMISE]}
        payments={[payment({
          receivedAt: "2026-07-30T09:00:00.000Z",
          createdAt: "2026-07-30T09:00:00.000Z",
        })]}
      />,
    )

    expect(html).toContain("Broken")
    expect(html).not.toContain("Kept")
  })

  it("does not credit a payment that arrived before the promise was made", () => {
    const html = renderToStaticMarkup(
      <PromiseToPayTab
        promises={[PROMISE]}
        payments={[payment({
          receivedAt: "2026-06-20T09:00:00.000Z",
          createdAt: "2026-07-02T09:00:00.000Z",
        })]}
      />,
    )

    expect(html).toContain("Broken")
  })
})
