/**
 * An explanation sits under its flag's summary in the credit checks row. So
 * each spec must add the rule and why it exists, not say the summary again.
 * The summaries come from the real rules (runChecks), raised by synthetic facts.
 */
import { describe, expect, it } from "vitest"
import { runChecks } from "@/lib/credit-checks/run-checks"
import { facts, statement, tx } from "@/lib/credit-checks/facts.test-helpers"
import type { ApplicationFacts } from "@/lib/credit-checks/types"
import { flagSpec, hasFlagSpec } from "./flag-specs"
import { checkFigures } from "./post-check-figures"
import { checkNoContradiction } from "./post-check-language"

const slip = { documentId: "slip-1", validated: true, matchesClient: true, netPayCents: 1_845_000, payDate: "2026-08-25" }
const salaryRows = ["2026-07-25", "2026-08-25", "2026-09-25"].map((d) => tx(d, "SALARY SYNTH EMPLOYER", 1_845_000))

/** Facts that between them raise every flag a spec covers. Every value is invented. */
const VARIANTS: ApplicationFacts[] = [
  facts({ statements: [] }),
  facts(),
  facts({ payslip: { ...slip, validated: false } }),
  facts({ payslip: { ...slip, matchesClient: false }, mismatchedPayslipIds: ["slip-1"] }),
  facts({ payslip: slip, statements: [statement([...salaryRows.slice(0, 1), tx("2026-08-25", "SALARY SYNTH EMPLOYER", 1_200_000), salaryRows[2]])] }),
  facts({ payslip: slip, statements: [statement([tx("2026-07-02", "SYNTH SHOP", -5_000)])] }),
  facts({ payslip: { ...slip, payDate: "2026-06-25" }, statements: [statement(salaryRows)] }),
  facts({
    clientName: "Someone Else",
    applicationDate: "2027-03-01",
    payslip: slip,
    priorOpenFlagApplications: [{ id: "app-0", reference: "APP-SYNTH-0", status: "IN_REVIEW" }],
    debts: [],
    statements: [statement([
      ...salaryRows,
      tx("2026-07-03", "UNPAID DEBIT ORDER SYNTH", -50_000),
      tx("2026-07-04", "HOLLYWOODBETS", -300_000),
      tx("2026-07-05", "WONGA LOAN", 100_000),
      ...["2026-07-06", "2026-08-06", "2026-09-06"].map((d) => tx(d, "DEBIT ORDER SYNTH CREDIT FINANCE", -120_000)),
      tx("2026-07-07", "SYNTH SHOP", -1_000, 1),
    ], {
      bank: "CAPITEC",
      authenticity: { producer: "Synth Editor 1.0", creator: null, createdAt: "2026-10-01T08:00:00Z", modifiedAt: "2026-10-03T08:00:00Z", incrementalUpdates: 2, signals: [] },
    })],
  }),
  facts({ statements: [statement([], { method: "VLM", balanceCheck: "FAIL" })] }),
  facts({ statements: [statement([], { state: "UNREADABLE" })] }),
  facts({ statements: [statement([], { bank: null })] }),
  facts({ statements: [statement([], { read: { ...statement([]).read!, accountHolderName: null } })] }),
  facts({ payslip: slip, statements: [statement([], { read: { ...statement([]).read!, periodEnd: "2026-07-10" } })] }),
  facts({ statements: [statement([tx("2026-07-02", "SYNTH SHOP", -5_000)], {
    authenticity: { producer: "OpenPDF 2.0.2", creator: null, createdAt: "2026-10-01T08:00:00Z", modifiedAt: null, incrementalUpdates: 0, signals: ["OPENING_DERIVED", "CLOSING_DERIVED", "ROWS_WITHOUT_BALANCE"] },
  })] }),
]

const STOP = new Set("the and that this with from was were could not its it's for into one are has have been but only any then than more less what which their they them each".split(" "))
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))

/** Share of the spec's words that the summary already uses. */
function overlap(spec: string, summary: string): number {
  const a = words(spec)
  const b = words(summary)
  return a.size ? [...a].filter((w) => b.has(w)).length / a.size : 0
}

const raised = new Map<string, string>()
for (const v of VARIANTS) for (const c of runChecks(v)) if (!raised.has(c.code)) raised.set(c.code, c.summary)

describe("flag specs against the summaries the rules write", () => {
  it("the variants raise the flags this test means to cover", () => {
    for (const code of ["NO_PAYSLIP", "NO_STATEMENT", "PAYSLIP_UNVALIDATED", "PAYSLIP_NOT_CLIENTS", "UNREADABLE", "UNVERIFIED_READ", "READ_INCOMPLETE", "AUTHENTICITY_UNCHECKED", "PRIOR_OPEN_FLAGS", "RETURNED_DEBIT", "PAYDAY_LENDER", "HOLDER_NAME_MISMATCH", "INCREMENTAL_UPDATE", "PRODUCER_UNEXPECTED", "MODIFIED_AFTER_CREATION", "STALE_STATEMENT", "GAMBLING", "SALARY_NOT_CHECKED", "FIRST_ROW_UNVERIFIED", "LAST_ROW_UNVERIFIED", "ROWS_UNCHECKED"]) {
      expect([...raised.keys()]).toContain(code)
    }
  })

  it("no spec says its flag's summary again in other words", () => {
    const report = [...raised].filter(([code]) => hasFlagSpec(code)).map(([code, summary]) => {
      const s = flagSpec(code, {})
      return { code, overlap: Math.round(overlap(`${s.rule} ${s.raisedWhen ?? ""}`, summary) * 100) }
    })
    expect(report.length).toBeGreaterThan(15)
    expect(report.filter((r) => r.overlap >= 50)).toEqual([])
  })

  // A text that fails these is withheld from the panel (views.ts): the new words must pass them.
  it("every spec passes the language and figure checks with its own flag raised", () => {
    for (const code of raised.keys()) {
      const s = flagSpec(code, {})
      const text = `${s.rule} ${s.raisedWhen ?? ""}`
      expect({ code, ...checkNoContradiction(text, [code]) }).toEqual({ code, ok: true })
      expect({ code, ...checkFigures(text, { amountsCents: [] }) }).toEqual({ code, ok: true })
    }
  })
})
