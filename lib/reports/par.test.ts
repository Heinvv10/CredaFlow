import { describe, it, expect, vi } from "vitest"

const getBookArrears = vi.fn()
vi.mock("@/lib/reports/book-arrears", () => ({ getBookArrears: (...a: unknown[]) => getBookArrears(...a) }))

import { getPortfolioPar } from "./par"

describe("getPortfolioPar", () => {
  it("is the shared book/arrears helper's PAR, not a second definition", async () => {
    const band = (count: number, value: number, pct: number) => ({ count, value, pct })
    getBookArrears.mockResolvedValue({
      scope: "ALL",
      chargesLive: false,
      book: { count: 10, value: 1000_00 },
      arrears: { count: 4, amount: 50_00, outstandingPrincipal: 500_00 },
      par30: band(3, 400_00, 40),
      par60: band(2, 200_00, 20),
      par90: band(1, 100_00, 10),
    })
    const par = await getPortfolioPar("t1")
    expect(getBookArrears).toHaveBeenCalledWith("t1")
    expect(par).toEqual({ book: 1000_00, par30: band(3, 400_00, 40), par60: band(2, 200_00, 20), par90: band(1, 100_00, 10) })
  })
})
