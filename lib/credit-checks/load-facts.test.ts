import { describe, expect, it } from "vitest"
import { bureauDebts, payslipFacts } from "./load-facts"

describe("payslipFacts", () => {
  const fields = (validated: boolean) => ({
    grossIncome: { value: 2_000_000, validated },
    totalDeductions: { value: 155_000, validated },
    netIncome: { value: 1_845_000, validated },
    payDate: { value: "2026-09-25", validated: true },
  })

  it("is validated only when every money field passed validation", () => {
    expect(payslipFacts("slip-1", fields(true))).toEqual({ documentId: "slip-1", validated: true, netPayCents: 1_845_000, payDate: "2026-09-25" })
    const one = { ...fields(true), totalDeductions: { value: 155_000, validated: false } }
    expect(payslipFacts("slip-1", one).validated).toBe(false)
    expect(payslipFacts("slip-1", { netIncome: { value: 1, validated: true } }).validated).toBe(false)
  })

  it("refuses a pay date or net pay it cannot read exactly", () => {
    const odd = { ...fields(true), netIncome: { value: "18450", validated: true }, payDate: { value: "25/09/2026", validated: true } }
    expect(payslipFacts("slip-1", odd)).toMatchObject({ netPayCents: null, payDate: null })
    expect(payslipFacts("slip-1", null)).toMatchObject({ validated: false, netPayCents: null })
  })
})

describe("bureauDebts", () => {
  it("reads the stored account list and skips malformed entries", () => {
    const obligations = {
      totalMonthly: 125_000,
      accounts: [
        { subscriber: "SYNTHLEND", accountType: "PERSONAL LOAN", instalmentCents: 125_000, status: "OPEN/CURRENT" },
        { subscriber: 7, instalmentCents: 1 },
        null,
      ],
    }
    expect(bureauDebts(obligations)).toEqual([{ name: "SYNTHLEND", monthlyInstalmentCents: 125_000, source: "BUREAU" }])
  })

  it("is empty for a check that stored no accounts", () => {
    expect(bureauDebts({ totalMonthly: 1 })).toEqual([])
    expect(bureauDebts(null)).toEqual([])
  })
})
