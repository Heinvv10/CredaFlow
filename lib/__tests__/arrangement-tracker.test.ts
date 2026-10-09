import { describe, it, expect } from "vitest"
import { analyseArrangement } from "../collections/arrangement-tracker"

// All offsets relative to today so tests don't drift as time passes.
function d(offsetDays: number): Date {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return date
}

function payment(amount: number, offsetDays: number) {
  return { id: `p${offsetDays}`, amount, receivedAt: d(offsetDays) }
}

// A receipt that reached us on one day and was captured by staff on a later
// one. `createdAt` is carried deliberately: it is what this module used to
// bucket on, and nothing may read it again.
function lateCaptured(amount: number, receivedOffset: number, capturedOffset: number) {
  return {
    id: `p${receivedOffset}-late`,
    amount,
    receivedAt: d(receivedOffset),
    createdAt: d(capturedOffset),
  }
}

describe("analyseArrangement", () => {
  // -------------------------------------------------------------------------
  // Upcoming — no past installments
  // -------------------------------------------------------------------------
  it("returns ON_TRACK with 100% compliance when all installments are upcoming", () => {
    // WEEKLY start d(7)→d(28): 4 installments, all future
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(7), endDate: d(28) },
      []
    )
    expect(result.overallStatus).toBe("ON_TRACK")
    expect(result.complianceRate).toBe(100)
    expect(result.upcomingCount).toBeGreaterThan(0)
    expect(result.keptCount).toBe(0)
    expect(result.missedCount).toBe(0)
  })

  it("credits an installment from the date the money arrived, not the date staff captured it", () => {
    // Client pays on time at d(-20), inside the d(-40)→d(-15) installment.
    // Branch cash sat on the desk and was only captured at d(-5), two weeks
    // into the NEXT window. Bucketing on capture time credits the installment
    // to nobody, marks a kept arrangement BROKEN, and feeds that into
    // collections escalation and ultimately a s129 notice.
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "MONTHLY", startDate: d(-40), endDate: d(-15) },
      [lateCaptured(100000, -20, -5)]
    )
    expect(result.installments[0].status).toBe("PAID")
    expect(result.overallStatus).not.toBe("BROKEN")
  })

  // -------------------------------------------------------------------------
  // Installment statuses
  // -------------------------------------------------------------------------
  it("marks installment PAID when amount is within 2% tolerance", () => {
    // 1-installment MONTHLY: d(-40) → d(-15). Payment 98% at d(-20).
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "MONTHLY", startDate: d(-40), endDate: d(-15) },
      [payment(98000, -20)]
    )
    expect(result.installments[0].status).toBe("PAID")
  })

  it("marks installment PARTIAL when amount is below 98% tolerance", () => {
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "MONTHLY", startDate: d(-40), endDate: d(-15) },
      [payment(50000, -20)]
    )
    expect(result.installments[0].status).toBe("PARTIAL")
  })

  it("marks installment MISSED when no payment received", () => {
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "MONTHLY", startDate: d(-40), endDate: d(-15) },
      []
    )
    expect(result.installments[0].status).toBe("MISSED")
  })

  it("marks installment UPCOMING when due date is in the future", () => {
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(7), endDate: d(14) },
      []
    )
    result.installments.forEach(i => expect(i.status).toBe("UPCOMING"))
  })

  // -------------------------------------------------------------------------
  // overallStatus transitions
  // -------------------------------------------------------------------------
  it("returns COMPLETED when all past installments paid and no upcoming", () => {
    // 2 WEEKLY periods: d(-18)→d(-5). Both fully paid.
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(-18), endDate: d(-5) },
      [payment(100000, -16), payment(100000, -9)]
    )
    expect(result.overallStatus).toBe("COMPLETED")
    expect(result.complianceRate).toBe(100)
    expect(result.upcomingCount).toBe(0)
  })

  it("returns BROKEN when 2 or more installments missed", () => {
    // 3 WEEKLY periods, no payments → missedCount=3
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(-25), endDate: d(-3) },
      []
    )
    expect(result.overallStatus).toBe("BROKEN")
    expect(result.missedCount).toBeGreaterThanOrEqual(2)
  })

  it("returns BROKEN when compliance rate drops below 50%", () => {
    // 2 WEEKLY periods: 10% paid on first, nothing on second → rate=5%
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(-18), endDate: d(-5) },
      [payment(10000, -16)]
    )
    expect(result.overallStatus).toBe("BROKEN")
    expect(result.complianceRate).toBeLessThan(50)
  })

  it("returns PARTIAL when one installment missed but compliance stays at 50%", () => {
    // 2 WEEKLY periods: first fully paid, second missed → rate=50%, missedCount=1
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(-18), endDate: d(-5) },
      [payment(100000, -16)]
    )
    expect(result.overallStatus).toBe("PARTIAL")
    expect(result.missedCount).toBe(1)
  })

  it("returns ON_TRACK when all past installments paid with upcoming remaining", () => {
    // 2 past WEEKLY (both paid) + 1 upcoming
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(-8), endDate: d(6) },
      [payment(100000, -5), payment(100000, -1)]
    )
    expect(result.overallStatus).toBe("ON_TRACK")
    expect(result.upcomingCount).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // complianceRate calculation
  // -------------------------------------------------------------------------
  it("computes complianceRate as totalPaid / totalExpected * 100 (rounded)", () => {
    // 2 WEEKLY periods: first 100%, second 50% → 75%
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(-18), endDate: d(-5) },
      [payment(100000, -16), payment(50000, -9)]
    )
    expect(result.complianceRate).toBe(75)
    expect(result.totalExpected).toBe(200000)
    expect(result.totalPaid).toBe(150000)
  })

  // -------------------------------------------------------------------------
  // Frequencies
  // -------------------------------------------------------------------------
  it("generates weekly installments at 7-day intervals", () => {
    // d(-22)→d(-2) WEEKLY: d(-22), d(-15), d(-8). Next=d(-1) > d(-2). 3 periods.
    const result = analyseArrangement(
      { agreedAmount: 50000, frequency: "WEEKLY", startDate: d(-22), endDate: d(-2) },
      []
    )
    expect(result.installments).toHaveLength(3)
  })

  it("generates biweekly installments at 14-day intervals", () => {
    // d(-30)→d(-3) BIWEEKLY: d(-30), d(-16). Next=d(-2) > d(-3). 2 periods.
    const result = analyseArrangement(
      { agreedAmount: 50000, frequency: "BIWEEKLY", startDate: d(-30), endDate: d(-3) },
      []
    )
    expect(result.installments).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // Variance and payment aggregation
  // -------------------------------------------------------------------------
  it("calculates variance as actualAmount - expectedAmount", () => {
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "MONTHLY", startDate: d(-40), endDate: d(-15) },
      [payment(120000, -20)]
    )
    expect(result.installments[0].variance).toBe(20000)
  })

  it("sums multiple payments within the same installment window", () => {
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "MONTHLY", startDate: d(-40), endDate: d(-15) },
      [payment(60000, -30), payment(40000, -20)]
    )
    expect(result.installments[0].actualAmount).toBe(100000)
    expect(result.installments[0].status).toBe("PAID")
  })

  // -------------------------------------------------------------------------
  // totalMissed
  // -------------------------------------------------------------------------
  it("totalMissed is the sum of expectedAmount for all MISSED installments", () => {
    // 3 WEEKLY periods, no payments → all 3 MISSED, totalMissed = 3 * agreedAmount
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(-25), endDate: d(-3) },
      []
    )
    const missedInstallments = result.installments.filter(i => i.status === "MISSED")
    const expectedTotalMissed = missedInstallments.reduce((s, i) => s + i.expectedAmount, 0)
    expect(result.totalMissed).toBe(expectedTotalMissed)
    expect(result.totalMissed).toBe(missedInstallments.length * 100000)
  })

  it("totalMissed is 0 when all installments are paid", () => {
    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "WEEKLY", startDate: d(-18), endDate: d(-5) },
      [payment(100000, -16), payment(100000, -9)]
    )
    expect(result.totalMissed).toBe(0)
  })

  // -------------------------------------------------------------------------
  // MONTHLY frequency
  // -------------------------------------------------------------------------
  it("generates monthly installments using calendar months", () => {
    // MONTHLY d(-90)→d(-30): 2 periods (d(-90) and d(-60)), next=d(-30) which is NOT <= d(-30)?
    // Actually next=d(-30) which equals endDate so we stop at 2 installments.
    // Use a range that clearly gives 2 monthly periods: startDate 3 months ago, endDate 1 month ago
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    start.setMonth(start.getMonth() - 3)
    const end = new Date()
    end.setHours(0, 0, 0, 0)
    end.setMonth(end.getMonth() - 1)

    const result = analyseArrangement(
      { agreedAmount: 100000, frequency: "MONTHLY", startDate: start, endDate: end },
      []
    )
    expect(result.installments.length).toBeGreaterThanOrEqual(2)
    // Each installment should be MISSED (past, no payments)
    result.installments.forEach(i => expect(i.status).toBe("MISSED"))
  })
})
