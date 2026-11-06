import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { MobileMoneyReview, type MobileMoneyReviewItem } from "./MobileMoneyReview"
import { formatZAR } from "@/lib/utils"

const item = (over: Partial<MobileMoneyReviewItem> = {}): MobileMoneyReviewItem => ({
  id: "mm1", status: "NEEDS_REVIEW", transId: "SIMSTK0001", billRef: "NRB-LN-1", amount: 120_000, reportedAmount: 99_000,
  reviewReason: "The provider reported a different amount", transactedAt: null, createdAt: "2026-11-08T09:00:00.000Z",
  simulated: true, msisdnLast4: "5678", loan: { id: "l1", reference: "NRB-LN-1" }, ...over,
})

describe("MobileMoneyReview", () => {
  it("shows what the provider reported paid as the amount, and what was requested beside it", () => {
    const html = renderToStaticMarkup(<MobileMoneyReview items={[item()]} canAct />).replace(/<!-- -->/g, "")
    expect(html).toContain(`${formatZAR(99_000)}<span`)
    expect(html).toContain(`reported paid; ${formatZAR(120_000)} was requested`)
  })

  it("shows the plain amount where nothing differs", () => {
    const html = renderToStaticMarkup(<MobileMoneyReview items={[item({ reportedAmount: null, amount: 50_000 })]} canAct />).replace(/<!-- -->/g, "")
    expect(html).toContain(formatZAR(50_000))
    expect(html).not.toContain("was requested")
  })
})
