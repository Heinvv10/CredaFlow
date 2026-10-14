import { describe, expect, it } from "vitest"
import { DECLARED_PAY_DAY_TRACKING_DAYS, recommendStrikeDate, type StrikeDateInput } from "./strike-date"

const NET = 1_500_000
const credit = (date: string, amountCents: number, description = "CREDIT TRANSFER") => ({ date, amountCents, description })
const input = (transactions: StrikeDateInput["statements"][number]["transactions"], patch: Partial<StrikeDateInput> = {}): StrikeDateInput => ({
  statements: [{ transactions }],
  netPayCents: NET,
  declaredPayDay: null,
  ...patch,
})

describe("recommendStrikeDate", () => {
  it("debits on the day the salary lands, with one tracking day when it lands on time", () => {
    const rec = recommendStrikeDate(input([
      credit("2026-07-25", NET), credit("2026-08-25", NET + 1_000), credit("2026-09-25", NET),
      credit("2026-08-10", 50_000), { date: "2026-08-26", amountCents: -NET, description: "RENT" },
    ]))
    expect(rec).toMatchObject({ debitDay: 25, trackingDays: 1, confidence: "HIGH", basis: "STATEMENT_SALARY" })
    expect(rec?.salaryDates).toEqual(["2026-07-25", "2026-08-25", "2026-09-25"])
  })

  it("covers a salary that lands late with tracking days", () => {
    const rec = recommendStrikeDate(input([credit("2026-07-25", NET), credit("2026-08-27", NET), credit("2026-09-25", NET)]))
    expect(rec).toMatchObject({ debitDay: 25, trackingDays: 3 })
  })

  it("handles a month-end payday that slips into the next month", () => {
    // Paid 31 Jul, 1 Sep (August's salary) and 30 Sep: debit on the 30th, track to the 1st.
    const rec = recommendStrikeDate(input([credit("2026-07-31", NET), credit("2026-09-01", NET), credit("2026-09-30", NET)]))
    expect(rec).toMatchObject({ debitDay: 30, trackingDays: 3 })
  })

  it("counts one salary per month: the credit nearest the net pay", () => {
    const rec = recommendStrikeDate(input([
      credit("2026-08-25", NET), credit("2026-08-15", NET * 0.6), credit("2026-09-25", NET),
    ]))
    expect(rec).toMatchObject({ debitDay: 25, confidence: "MEDIUM" })
    expect(rec?.salaryDates).toEqual(["2026-08-25", "2026-09-25"])
  })

  it("finds salary credits by description when there is no validated net pay", () => {
    const rec = recommendStrikeDate(input(
      [credit("2026-08-20", 900_000, "ACME PTY SALARY"), credit("2026-09-21", 900_000, "ACME PTY SALARY"), credit("2026-09-05", 2_000_000, "TRANSFER FROM SAVINGS")],
      { netPayCents: null },
    ))
    expect(rec).toMatchObject({ debitDay: 20, trackingDays: 2, confidence: "MEDIUM", basis: "STATEMENT_SALARY" })
  })

  it("ignores non-posting rows and debits", () => {
    const rec = recommendStrikeDate(input([
      { date: "2026-09-25", amountCents: NET, description: "EDO COLLECTION ATTEMPT", nonPosting: true },
      { date: "2026-09-24", amountCents: -NET, description: "SALARY REVERSAL" },
    ]))
    expect(rec).toBeNull()
  })

  it("falls back to the declared pay day, at low confidence", () => {
    const rec = recommendStrikeDate(input([], { declaredPayDay: 15 }))
    expect(rec).toEqual({
      debitDay: 15, trackingDays: DECLARED_PAY_DAY_TRACKING_DAYS, confidence: "LOW", basis: "DECLARED_PAY_DAY", salaryDates: [],
    })
  })

  it("recommends nothing without salary evidence or a declared pay day", () => {
    expect(recommendStrikeDate(input([credit("2026-09-03", 20_000)]))).toBeNull()
  })

  it("never recommends more tracking days than the scheme allows", () => {
    const rec = recommendStrikeDate(input([credit("2026-07-01", NET), credit("2026-08-01", NET), credit("2026-09-20", NET)]))
    expect(rec?.trackingDays).toBeLessThanOrEqual(10)
  })
})
