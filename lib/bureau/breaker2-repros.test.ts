/**
 * PR #78 review round 2: two affordability bypasses through the Experian
 * response. Each goes from the raw REST body, through the client's parser and
 * the adapter, to the figure affordability and the bureau gate read.
 */
import { describe, expect, it } from "vitest"
import { bureauObligationsKnown } from "@/lib/affordability/snapshot"
import { evaluateBureauGate } from "@/lib/decision/bureau-gate"
import { parseEnquiryResult, type ExperianResult } from "@/lib/integrations/experian"
import { bureauInstalmentTotalCents } from "./normalise"
import { reportObligations } from "./persist"
import { experianReport } from "./providers/experian"

type Account = { subscriber_name?: string; status_code_desc: string; instalment_amount?: unknown; account_type_code_desc?: string }

function report(accounts: Account[]) {
  const parsed = parseEnquiryResult({
    response_status: "Success",
    return_data: {
      bureau_match: { status_code: 1 },
      bureau_scores: [{ score_type: "SS", score: 650, version: 4, risk_type: "LOW RISK" }],
      accounts,
    },
  })
  if (!parsed.ok) throw new Error("synthetic response did not parse")
  return experianReport(parsed as ExperianResult & { ok: true })
}

const gate = (r: ReturnType<typeof report>) => evaluateBureauGate({
  score: 650, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false,
  hasJudgement: false, hasNotice: false, obligations: reportObligations(r),
}, { bureauMinScore: 600, bureauBlockAdverse: false })

describe("R2-1: an instalment amount that is not a number", () => {
  it("reads a clean decimal string as that amount", () => {
    const r = report([{ subscriber_name: "SYNTHETIC BANK", status_code_desc: "OPEN/CURRENT", instalment_amount: "5000.00" }])
    expect(bureauInstalmentTotalCents(r)).toBe(500_000)
  })

  it("makes the debt unknown when an open account's amount cannot be read, so the gate refuses it", () => {
    const r = report([
      { subscriber_name: "SYNTHETIC BANK", status_code_desc: "OPEN/CURRENT", instalment_amount: 1200 },
      { subscriber_name: "SYNTHETIC RETAIL", status_code_desc: "OPEN/CURRENT", instalment_amount: "R5,000" },
    ])
    expect(bureauInstalmentTotalCents(r)).toBeNull()
    expect(bureauObligationsKnown(reportObligations(r))).toBe(false)
    expect(gate(r).blocked).toBe(true)
  })

  it("ignores an unreadable amount on a closed account", () => {
    const r = report([
      { subscriber_name: "SYNTHETIC BANK", status_code_desc: "OPEN/CURRENT", instalment_amount: 1200 },
      { subscriber_name: "SYNTHETIC OLD", status_code_desc: "ACCOUNT CLOSED", instalment_amount: "n/a" },
    ])
    expect(bureauInstalmentTotalCents(r)).toBe(120_000)
  })
})

describe("R2-2: an account with no subscriber name", () => {
  it("still counts when it is in arrears (not OPEN/CURRENT, so not in Experian's own total)", () => {
    const r = report([
      { subscriber_name: "SYNTHETIC BANK", status_code_desc: "OPEN/CURRENT", instalment_amount: 1000 },
      { status_code_desc: "OPEN/ARREARS", instalment_amount: 4000 },
      { subscriber_name: "", status_code_desc: "OPEN/ARREARS", instalment_amount: 500 },
    ])
    expect(bureauInstalmentTotalCents(r)).toBe(550_000)
    expect(r.tradelines.filter((t) => t.subscriber === "UNKNOWN")).toHaveLength(2)
  })

  it("is kept out of the credit checks' named account list", () => {
    const r = report([{ status_code_desc: "OPEN/ARREARS", instalment_amount: 4000 }])
    expect(reportObligations(r)).toEqual({ totalMonthly: 400_000 })
  })
})
