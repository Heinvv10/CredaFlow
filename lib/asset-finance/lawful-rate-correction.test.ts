import { expect, it } from "vitest"
import { computeNonNcaCharges } from "./non-nca-charges"
import { lawfulRateCorrection } from "./lawful-rate-correction"
import type { ChargesReplay } from "@/lib/loan/charges-replay"
const at = (day: string) => new Date(`${day}T10:00:00+02:00`)
it("a late rate change cannot refund or debit permanently blocked interest", () => {
  const rows = [
    { dueDate: at("2026-01-02"), principalDue: 0, interestDue: 100, feesDue: 0, totalDue: 100 },
    { dueDate: at("2026-01-03"), principalDue: 100, interestDue: 0, commonLawContractualInterestDue: 10, feesDue: 0, totalDue: 100 },
  ]
  const replay = { replayAt: (asOf: Date, _extra: unknown, proposed: { schedule: typeof rows; contractRateHistory: Array<{ effectiveDate: Date; annualRate: number }> }) => computeNonNcaCharges({ schedule: proposed.schedule, contractRateHistory: proposed.contractRateHistory,
    startDate: at("2026-01-01"), maturityDate: at("2026-01-03"), asOf, interestRatePm: 0.1 / 12, defaultInterestMargin: null, collectionFeeCents: null,
    receipts: [{ id: "synthetic-cash", amount: 200, receivedAt: at("2026-01-04") }],
  }) } as unknown as ChargesReplay
  for (const rate of [0.09, 0.11]) expect(lawfulRateCorrection(replay, rows, "2026-01-01", [{ effectiveDate: "2026-01-01", annualRate: 0.1 }], [{ effectiveDate: "2026-01-01", annualRate: 0.1 }, { effectiveDate: "2026-01-03", annualRate: rate }], at("2026-01-04"), 999)).toBe(0)
})

it("preserves the exact cash-based correction when neither historical replay reaches the ceiling", () => {
  const rows = [{ dueDate: at("2026-01-31"), principalDue: 100000, interestDue: 822, feesDue: 0, totalDue: 100822 }]
  const replay = { replayAt: (asOf: Date, _extra: unknown, proposed: { schedule: typeof rows; contractRateHistory: Array<{ effectiveDate: Date; annualRate: number }> }) => computeNonNcaCharges({ schedule: proposed.schedule, contractRateHistory: proposed.contractRateHistory,
    startDate: at("2026-01-01"), maturityDate: at("2026-01-31"), asOf, interestRatePm: 0.1 / 12, defaultInterestMargin: null, collectionFeeCents: null,
    receipts: [{ id: "synthetic-on-time", amount: 100822, receivedAt: at("2026-01-31") }],
  }) } as unknown as ChargesReplay
  expect(lawfulRateCorrection(replay, rows, "2026-01-01", [{ effectiveDate: "2026-01-01", annualRate: 0.1 }], [{ effectiveDate: "2026-01-01", annualRate: 0.1 }, { effectiveDate: "2026-01-15", annualRate: 0.08 }], at("2026-01-31"), -93)).toBe(-93)
})
