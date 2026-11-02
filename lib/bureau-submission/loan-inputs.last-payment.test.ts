import { describe, expect, it } from "vitest"
import { lastPaymentOnOrBefore } from "./loan-inputs"

const payment = (paymentMethod: string, receivedAt: string) => ({ paymentMethod, receivedAt: new Date(receivedAt), reversed: false, allocationStatus: "ALLOCATED" })

describe("lastPaymentOnOrBefore", () => {
  it("is the last cash received: a waiver or a settlement by a new loan is not a payment", () => {
    const loan = { payments: [payment("EFT", "2026-08-01T10:00:00Z"), payment("WAIVER", "2026-08-05T10:00:00Z"), payment("LOAN_SETTLEMENT", "2026-08-09T10:00:00Z")] }
    expect(lastPaymentOnOrBefore(loan as never, "2026-08-31" as never)).toEqual(new Date("2026-08-01T10:00:00Z"))
  })
})
