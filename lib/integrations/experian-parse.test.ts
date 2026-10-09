import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"
import { parseEnquiryResult } from "@/lib/integrations/experian"

const dir = path.join(__dirname, "__fixtures__", "experian")
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))

describe("parseEnquiryResult — real UAT responses", () => {
  it("Deceased: hard-flags, no numeric score, not a clean pass", () => {
    const r = parseEnquiryResult(load("deceased.json"))
    expect(r.bureauMatchStatus).toBe(3)
    expect(r.deceased).toBe(true)
    expect(r.score).toBeNull()          // -1 sentinel is NOT a score
    expect(r.unscoreable).toBe(true)
  })

  it("Debt Restructuring: picks latest-version real score, flags debt review", () => {
    const r = parseEnquiryResult(load("debt-restructuring.json"))
    expect(r.score).toBe(611)           // v4.01, not the -4 v4.0 sentinel
    expect(r.riskGrade).toBe("VERY HIGH RISK")  // risk_type, not "SS"
    expect(r.underDebtReview).toBe(true)
    expect(r.deceased).toBe(false)
  })

  it("Adverse: maps adverse_code_desc + obligations in cents", () => {
    const r = parseEnquiryResult(load("adverse.json"))
    expect(r.adverseInfo).toContain("WRITTEN OFF")
    expect(r.riskGrade).toBe("VERY HIGH RISK")
    expect(r.score).toBe(574)
    // 5 OPEN/CURRENT accounts, instalment_amount sum = R6,126 (whole Rands) → 612600 cents.
    expect(r.totalMonthlyObligations).toBe(612600)
  })

  it("Judgements: flags judgement even with no adverses[]", () => {
    const r = parseEnquiryResult(load("judgements.json"))
    expect(r.hasJudgement).toBe(true)
    expect(r.score).toBe(584)
  })

  it("Sequestration: flags notice", () => {
    const r = parseEnquiryResult(load("sequestration.json"))
    expect(r.hasNotice).toBe(true)
  })

  it("Adverse: exposes decline reasons (NCA adverse-action codes)", () => {
    const r = parseEnquiryResult(load("adverse.json"))
    expect(r.declineReasons?.length ?? 0).toBeGreaterThan(0)
    expect(r.declineReasons?.[0]).toMatch(/^TM\d+/) // e.g. "TM57-High number of..."
  })

  it("treats an SS score above the 480–710 band as unscoreable, never a numeric score", () => {
    const r = parseEnquiryResult({
      response_status: "Success",
      return_data: {
        bureau_match: { status_code: 1 },
        bureau_scores: [{ score_type: "SS", score: 999, version: 4.01, risk_type: "ANOMALY" }],
      },
    })
    expect(r.score).toBeNull()
    expect(r.unscoreable).toBe(true)
  })

  it("only ever returns a score inside the 480–710 band for any fixture", () => {
    for (const f of fs.readdirSync(dir)) {
      const r = parseEnquiryResult(load(f))
      if (r.score != null) {
        expect(r.score).toBeGreaterThanOrEqual(480)
        expect(r.score).toBeLessThanOrEqual(710)
      }
    }
  })
})
