import { sastStartOfDay } from "@/lib/date/sast"

/**
 * Payment Arrangement Tracker
 * Calculates expected installments from an arrangement and compares to actual payments.
 */

export interface ArrangementInput {
  agreedAmount: number   // cents per installment
  frequency: string      // WEEKLY | BIWEEKLY | MONTHLY
  startDate: Date
  endDate: Date
}

export interface ActualPayment {
  id: string
  amount: number
  /**
   * The date the money reached us, NOT the date staff captured it. A receipt
   * banked inside an installment window but captured after it still keeps that
   * installment; bucketing on capture time breaks a kept arrangement, which
   * feeds collections escalation and, downstream, a s129 notice.
   */
  receivedAt: Date
}

export interface InstallmentResult {
  period: number
  dueDate: Date
  expectedAmount: number
  actualAmount: number
  status: "PAID" | "PARTIAL" | "MISSED" | "UPCOMING"
  variance: number   // actual - expected (negative = shortfall)
}

export interface ArrangementSummary {
  installments: InstallmentResult[]
  totalExpected: number
  totalPaid: number
  totalMissed: number
  keptCount: number
  missedCount: number
  partialCount: number
  upcomingCount: number
  overallStatus: "ON_TRACK" | "PARTIAL" | "BROKEN" | "COMPLETED"
  complianceRate: number  // 0-100%
}

function addPeriod(date: Date, frequency: string): Date {
  const d = new Date(date)
  switch (frequency) {
    case "WEEKLY":   d.setDate(d.getDate() + 7); break
    case "BIWEEKLY": d.setDate(d.getDate() + 14); break
    case "MONTHLY":  d.setMonth(d.getMonth() + 1); break
    default:         d.setMonth(d.getMonth() + 1)
  }
  return d
}

// SAST midnight. Which day a payment lands on decides whether an instalment
// of an arrangement counts as KEPT or BROKEN, and a broken arrangement is a
// collections escalation against a real person. On a UTC container a payment
// made at 00:30 SAST on the due date fell into the previous day's window: the
// due period recorded nothing and the client was judged to have broken an
// arrangement they in fact honoured.
function startOfDay(d: Date): Date {
  return sastStartOfDay(d)
}

/**
 * Groups actual payments into installment periods.
 * Each period runs from its due date to the next due date.
 */
function sumPaymentsInWindow(payments: ActualPayment[], from: Date, to: Date): number {
  return payments
    .filter(p => {
      const pd = startOfDay(new Date(p.receivedAt))
      return pd >= startOfDay(from) && pd < startOfDay(to)
    })
    .reduce((sum, p) => sum + p.amount, 0)
}

export function analyseArrangement(
  arrangement: ArrangementInput,
  actualPayments: ActualPayment[]
): ArrangementSummary {
  const today = startOfDay(new Date())
  const installments: InstallmentResult[] = []

  let period = 1
  let current = new Date(arrangement.startDate)

  while (current <= arrangement.endDate) {
    const next = addPeriod(current, arrangement.frequency)
    const windowEnd = next > arrangement.endDate ? new Date(arrangement.endDate.getTime() + 86400000) : next
    const dueDate = startOfDay(current)

    const actualAmount = sumPaymentsInWindow(actualPayments, current, windowEnd)
    const expected = arrangement.agreedAmount
    const variance = actualAmount - expected

    let status: InstallmentResult["status"]
    if (dueDate > today) {
      status = "UPCOMING"
    } else if (actualAmount >= expected * 0.98) {
      // Within 2% tolerance
      status = "PAID"
    } else if (actualAmount > 0) {
      status = "PARTIAL"
    } else {
      status = "MISSED"
    }

    installments.push({ period, dueDate, expectedAmount: expected, actualAmount, status, variance })
    period++
    current = next
  }

  const past = installments.filter(i => i.status !== "UPCOMING")
  const totalExpected = past.reduce((s, i) => s + i.expectedAmount, 0)
  const totalPaid = past.reduce((s, i) => s + i.actualAmount, 0)
  const totalMissed = past.filter(i => i.status === "MISSED").reduce((s, i) => s + i.expectedAmount, 0)
  const keptCount = past.filter(i => i.status === "PAID").length
  const missedCount = past.filter(i => i.status === "MISSED").length
  const partialCount = past.filter(i => i.status === "PARTIAL").length
  const upcomingCount = installments.filter(i => i.status === "UPCOMING").length

  const complianceRate = past.length > 0
    ? Math.round((totalPaid / totalExpected) * 100)
    : 100

  let overallStatus: ArrangementSummary["overallStatus"]
  if (past.length === 0) {
    overallStatus = "ON_TRACK"
  } else if (upcomingCount === 0 && missedCount === 0 && partialCount === 0) {
    overallStatus = "COMPLETED"
  } else if (missedCount >= 2 || complianceRate < 50) {
    overallStatus = "BROKEN"
  } else if (missedCount > 0 || partialCount > 0) {
    overallStatus = "PARTIAL"
  } else {
    overallStatus = "ON_TRACK"
  }

  return {
    installments,
    totalExpected,
    totalPaid,
    totalMissed,
    keptCount,
    missedCount,
    partialCount,
    upcomingCount,
    overallStatus,
    complianceRate,
  }
}
