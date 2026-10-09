import { describe, it, expect, vi } from "vitest"
import { reverseReferralCommissionForLoan } from "./commission"

describe("reverseReferralCommissionForLoan", () => {
  it("flips PENDING/PAYABLE CONVERTED events for the loan to REVERSED", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    await reverseReferralCommissionForLoan({ referralEvent: { updateMany } } as never, {
      tenantId: "t1", loanId: "L1",
    })
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        eventType: "CONVERTED",
        commissionStatus: { in: ["PENDING", "PAYABLE"] },
        metadata: { path: ["loanId"], equals: "L1" },
      },
      data: { commissionStatus: "REVERSED" },
    })
  })
})
