import { describe, expect, it } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { toDayNumber } from "@/lib/asset-finance/dates"
import { legalMatterSeedDates } from "./asset-finance-recovery-dates"

describe("legalMatterSeedDates", () => {
  it("keeps the synthetic legal history inside the demo clock-check window", () => {
    const today = "2026-04-01"
    const dates = legalMatterSeedDates(today)
    const todayDay = toDayNumber(today)
    const ordered = Object.values(dates).map((date) => toDayNumber(date))

    expect(ordered.every((day) => day >= todayDay - 31 && day <= todayDay)).toBe(true)
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
    expect(toDayNumber(dates.summonsIssuedOn)).toBeGreaterThanOrEqual(
      toDayNumber(addSouthAfricanBusinessDays(dates.s129On, 10)),
    )
  })
})
