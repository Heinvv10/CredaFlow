import { describe, expect, it } from "vitest"
import { eclWorkbookSheets } from "./export"
import type { LoanEclRow, RunReport } from "./run-report"

const loan: LoanEclRow = {
  reference: "L-1", product: "Personal loan", contractType: "LOAN", loanStatus: "DEFAULTED", daysPastDue: 92, stage: 3, previousStage: 2,
  reasons: ["DPD_AT_DEFAULT_THRESHOLD", "STATUS_DEFAULTED"], stageSince: "2026-10-31", outstandingPrincipalCents: 500_000,
  unpaidInterestCents: 40_000, unpaidFeesCents: 20_000, chargesOutstandingCents: 12_000, accruedInterestCents: 0,
  suspendedInterestCents: 40_000, suspendedDefaultInterestCents: 4_000, eadCents: 528_000, parameterScope: "DEFAULT", pdBps: 10_000, lgdBps: 6000, eclCents: 316_800,
}
const run = { id: "r2", kind: "MONTHLY" as const, runDate: "2026-10-31", periodKey: "2026-10", loanCount: 1, totalEadCents: 528_000, totalEclCents: 316_800, createdAt: "2026-10-31T21:50:00.000Z", late: false, superseded: false, supersedesRunId: null, reason: null }
const report: RunReport = {
  run, previousRun: { ...run, id: "r1", runDate: "2026-09-30", periodKey: "2026-09" },
  summary: {
    byStage: [
      { stage: 1, loans: 0, eadCents: 0, eclCents: 0, coverageBps: 0, suspendedCents: 0 },
      { stage: 2, loans: 0, eadCents: 0, eclCents: 0, coverageBps: 0, suspendedCents: 0 },
      { stage: 3, loans: 1, eadCents: 528_000, eclCents: 316_800, coverageBps: 6000, suspendedCents: 44_000 },
    ],
    total: { loans: 1, eadCents: 528_000, eclCents: 316_800, coverageBps: 6000, suspendedCents: 44_000 },
  },
  transitions: { cells: [{ from: "2", to: "3", loans: 1, fromEadCents: 500_000, toEadCents: 528_000 }], deteriorated: 1, improved: 0, unchanged: 0 },
}

describe("eclWorkbookSheets", () => {
  const sheets = eclWorkbookSheets(report, [loan])
  const sheet = (name: string) => sheets.find((s) => s.name === name)!.rows

  it("has the loan-level ECL, the stage summary and the transition matrix", () => {
    expect(sheets.map((s) => s.name)).toEqual(["Loan ECL", "Stage summary", "Transitions"])
  })

  it("states money in rand and rates in percent, as the other exports do", () => {
    expect(sheet("Loan ECL")[0]).toMatchObject({
      Loan: "L-1", Stage: 3, "Previous stage": 2, "Days past due": 92, "EAD (R)": 5280, "PD (%)": 100, "LGD (%)": 60, "ECL (R)": 3168,
      "Interest in suspense (R)": 400, "Default interest in suspense (R)": 40, "Reasons": "DPD_AT_DEFAULT_THRESHOLD; STATUS_DEFAULTED",
    })
  })

  it("summarises by stage with a total row and coverage in percent", () => {
    const rows = sheet("Stage summary")
    expect(rows.map((r) => r.Stage)).toEqual(["Stage 1", "Stage 2", "Stage 3", "Total"])
    expect(rows[2]).toMatchObject({ Loans: 1, "EAD (R)": 5280, "ECL (R)": 3168, "Coverage (%)": 60 })
  })

  it("lays the transitions out by run date", () => {
    expect(sheet("Transitions")[0]).toMatchObject({ From: "Stage 2", To: "Stage 3", Loans: 1, "Earlier EAD (R)": 5000, "Later EAD (R)": 5280, "Earlier run": "2026-09-30", "Later run": "2026-10-31" })
  })

  it("leaves the transitions sheet empty when there is no earlier run", () => {
    expect(eclWorkbookSheets({ ...report, previousRun: null, transitions: null }, [loan]).find((s) => s.name === "Transitions")!.rows).toEqual([])
  })
})
