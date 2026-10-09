import { describe, expect, it } from "vitest"
import { validateDocumentAgainstClient } from "./documentValidationService"

// Synthetic payslip figures: gross R40,123.45,
// deductions R13,580.24, net R26,543.21. Cents throughout — Client.monthlyIncome
// and Client.grossMonthlyIncome are both Int cents.
const GROSS_CENTS = 4012345
const NET_CENTS = 2654321

function payslipFields(values: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, { value: v, validated: true }]),
  )
}

function clientDb(overrides: Record<string, unknown>) {
  return {
    client: {
      findUnique: async () => ({
        idNumber: "9201010000086",
        firstName: "Lerato",
        lastName: "Mokoena",
        dateOfBirth: new Date("1993-01-20T00:00:00.000Z"),
        bankAccountNumber: "10000012345",
        bankName: "DISCOVERY",
        employerName: "Acme Mining (Pty) Ltd",
        monthlyIncome: 0,
        grossMonthlyIncome: null,
        addressLine1: null,
        city: null,
        ...overrides,
      }),
    },
  } as unknown as { client: unknown }
}

const validate = (fields: Record<string, unknown>, client: Record<string, unknown>) =>
  validateDocumentAgainstClient(
    fields as Parameters<typeof validateDocumentAgainstClient>[0],
    "PAYSLIP",
    "client-1",
    clientDb(client),
  )

describe("validateDocumentAgainstClient — payslip income", () => {
  // The payslip's gross was compared against Client.monthlyIncome, which holds
  // NET pay. On a correctly-extracted payslip the two differ by the whole
  // deductions line — R40,123.45 vs R26,543.21 is 50% apart — so every clean
  // payslip raised a false "income differs by more than 20%" warning and the
  // document showed a 0% match badge. Compare like with like.
  it("does not flag a clean payslip whose gross exceeds the client's NET income", async () => {
    const result = await validate(
      payslipFields({ grossIncome: GROSS_CENTS, netIncome: NET_CENTS }),
      { monthlyIncome: NET_CENTS, grossMonthlyIncome: null },
    )

    expect(result.mismatches).toEqual([])
    expect(result.matches).toContain("Net Income")
  })

  it("compares gross against the client's gross when the record has one", async () => {
    const result = await validate(
      payslipFields({ grossIncome: GROSS_CENTS, netIncome: NET_CENTS }),
      { monthlyIncome: NET_CENTS, grossMonthlyIncome: GROSS_CENTS },
    )

    expect(result.mismatches).toEqual([])
    expect(result.matches).toEqual(expect.arrayContaining(["Gross Income", "Net Income"]))
  })

  it("still flags a gross that really is more than 20% off the record", async () => {
    const result = await validate(
      payslipFields({ grossIncome: GROSS_CENTS, netIncome: NET_CENTS }),
      { monthlyIncome: NET_CENTS, grossMonthlyIncome: 2000000 },
    )

    expect(result.mismatches).toMatchObject([
      { field: "grossIncome", severity: "warning", documentValue: "R 40123.45" },
    ])
  })

  it("still flags a net that really is more than 20% off the record", async () => {
    const result = await validate(
      payslipFields({ grossIncome: GROSS_CENTS, netIncome: NET_CENTS }),
      { monthlyIncome: 1000000, grossMonthlyIncome: GROSS_CENTS },
    )

    expect(result.mismatches).toMatchObject([{ field: "netIncome", severity: "warning" }])
  })

  it("skips the gross comparison entirely when the record has no gross captured", async () => {
    const result = await validate(
      payslipFields({ grossIncome: GROSS_CENTS }),
      { monthlyIncome: NET_CENTS, grossMonthlyIncome: null },
    )

    expect(result.mismatches).toEqual([])
    expect(result.matches).not.toContain("Gross Income")
  })
})
