import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PaymentForm } from "./PaymentForm"

// NOTE: renderToStaticMarkup cannot drive state. `receivedAt` is therefore
// always "", so every branch gated on a chosen back-date is permanently absent
// and CANNOT be asserted here — a test naming those branches would pass no
// matter what the gate said. Two such tests were deleted rather than kept as
// decoration.
//
// The rule they claimed to cover now lives in `valueDatePrompt`
// (lib/payments/value-date-payload.ts) and is tested there, where mutating it
// genuinely fails. What remains below is only what a static render can see.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

vi.mock("@/lib/toast", () => ({
  toast: { payment: { recorded: vi.fn(), failed: vi.fn() } },
}))

function render(canAuthoriseBackdate: boolean) {
  return renderToStaticMarkup(
    <PaymentForm
      loanId="loan-1"
      settlementAmount={400_000}
      contractualBalance={500_000}
      loanStartDay="2026-07-04"
      canAuthoriseBackdate={canAuthoriseBackdate}
    />,
  )
}

describe("PaymentForm value date", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("offers a value-date field bounded by disbursement and today", () => {
    const html = render(true)

    expect(html).toContain("Date Received")
    // Mirrors rejectImpossibleValueDate: money cannot have arrived before the
    // loan was disbursed. Without the min, staff can enter a date that prices
    // the loan at day zero and only find out on submit.
    expect(html).toContain('min="2026-07-04"')
    expect(html).toContain('type="date"')
  })

  it("will not offer a future date, in SAST rather than the browser's zone", () => {
    // 22:30 UTC on the 23rd is already the 24th in SAST. A browser-local
    // formatter would cap the field at the 23rd and refuse a same-day capture
    // made that evening.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-23T22:30:00.000Z"))

    expect(render(true)).toContain('max="2026-07-24"')
  })
})
