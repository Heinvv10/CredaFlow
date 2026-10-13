import { describe, expect, it } from "vitest"
import { bureauDebts, payslipFacts, payslipNamesClient } from "./load-facts"

const client = { fullName: "Thabo Tester", idNumber: "9001015000080" }

describe("payslipFacts", () => {
  const fields = (validated: boolean) => ({
    grossIncome: { value: 2_000_000, validated },
    totalDeductions: { value: 155_000, validated },
    netIncome: { value: 1_845_000, validated },
    payDate: { value: "2026-09-25", validated: true },
    employeeIdNumber: { value: "9001015000080", validated: true },
  })

  it("is validated only when every money field passed validation", () => {
    expect(payslipFacts("slip-1", fields(true), false, client)).toEqual({ documentId: "slip-1", validated: true, matchesClient: true, netPayCents: 1_845_000, payDate: "2026-09-25" })
    expect(payslipFacts("slip-1", fields(true), true, client).matchesClient).toBe(false)
    const one = { ...fields(true), totalDeductions: { value: 155_000, validated: false } }
    expect(payslipFacts("slip-1", one, false, client).validated).toBe(false)
    expect(payslipFacts("slip-1", { netIncome: { value: 1, validated: true } }, false, client).validated).toBe(false)
  })

  it("refuses a pay date or net pay it cannot read exactly", () => {
    const odd = { ...fields(true), netIncome: { value: "18450", validated: true }, payDate: { value: "25/09/2026", validated: true } }
    expect(payslipFacts("slip-1", odd, false, client)).toMatchObject({ netPayCents: null, payDate: null })
    expect(payslipFacts("slip-1", null, false, client)).toMatchObject({ validated: false, netPayCents: null })
  })
})

describe("payslipNamesClient", () => {
  // Extraction-shaped fields, as lib/vlm-extract.ts stores them on the document.
  const slip = (over: Record<string, { value: unknown; validated: boolean }>) => ({ netIncome: { value: 1, validated: true }, ...over })

  it("matches on the printed ID number when there is one", () => {
    expect(payslipNamesClient(slip({ employeeIdNumber: { value: "900101 5000 080", validated: true } }), client)).toBe(true)
    expect(payslipNamesClient(slip({ employeeIdNumber: { value: "8501015000081", validated: true }, employeeName: { value: "Thabo Tester", validated: true } }), client)).toBe(false)
  })

  it("reads an ID the model answered as a number", () => {
    expect(payslipNamesClient(slip({ employeeIdNumber: { value: 9001015000080, validated: true } }), client)).toBe(true)
    expect(payslipNamesClient(slip({ employeeIdNumber: { value: 8501015000081, validated: true }, employeeName: { value: "T Tester", validated: true } }), client)).toBe(false)
  })

  it("never falls back to the name when ID digits were printed but are not the client's", () => {
    const named = { employeeName: { value: "MR T TESTER", validated: true } }
    expect(payslipNamesClient(slip({ ...named, employeeIdNumber: { value: "900101500008", validated: true } }), client)).toBe(false)
    expect(payslipNamesClient(slip({ ...named, employeeIdNumber: { value: "Emp 4471", validated: true } }), client)).toBe(false)
    // The client's ID printed beside an employee number still matches.
    expect(payslipNamesClient(slip({ employeeIdNumber: { value: "9001015000080 / Emp 4471", validated: true } }), client)).toBe(true)
  })

  it("matches no printed ID against a client without a 13-digit SA ID on record", () => {
    const printed = slip({ employeeIdNumber: { value: "9001015000080", validated: true }, employeeName: { value: "Thabo Tester", validated: true } })
    for (const idNumber of [null, "", "A12345678"]) {
      expect(payslipNamesClient(printed, { fullName: "Thabo Tester", idNumber }), String(idNumber)).toBe(false)
    }
  })

  it("falls back to the employee name when no ID number is printed", () => {
    expect(payslipNamesClient(slip({ employeeName: { value: "MR T TESTER", validated: true } }), client)).toBe(true)
    expect(payslipNamesClient(slip({ employeeName: { value: "Sipho Synthetic", validated: true } }), client)).toBe(false)
  })

  it("does not confirm a payslip whose ID and name could not be read", () => {
    expect(payslipNamesClient(slip({}), client)).toBe(false)
    expect(payslipNamesClient(slip({ employeeName: { value: "  ", validated: true } }), client)).toBe(false)
  })

  it("decides payslipFacts.matchesClient even though the upload validator passed it", () => {
    expect(payslipFacts("slip-1", slip({ employeeName: { value: "Sipho Synthetic", validated: true } }), false, client).matchesClient).toBe(false)
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

  it("leaves out closed and settled accounts: they explain no current debit order", () => {
    const obligations = { accounts: [
      { subscriber: "SYNTHLEND", instalmentCents: 125_000, status: "ACCOUNT CLOSED" },
      { subscriber: "OTHERCO", instalmentCents: 50_000, status: "PAID UP" },
      { subscriber: "THIRDCO", instalmentCents: 10_000, status: "OPEN/CURRENT" },
    ] }
    expect(bureauDebts(obligations).map((d) => d.name)).toEqual(["THIRDCO"])
  })

  it("is empty for a check that stored no accounts", () => {
    expect(bureauDebts({ totalMonthly: 1 })).toEqual([])
    expect(bureauDebts(null)).toEqual([])
  })
})
