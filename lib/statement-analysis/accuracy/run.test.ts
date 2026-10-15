/** The accuracy report's arithmetic, on fixed outcomes (the corpus run itself is accuracy.integration.test.ts). */
import { describe, expect, it } from "vitest"
import type { StatementAnalysisResult } from "../analyse"
import { formatReport, outcomeOf, TEXT_GATES, textPassRate, type Outcome } from "./run"

const o = (bank: string, balanceCheck: string, bankProduced = true, method: Outcome["method"] = "TEXT"): Outcome =>
  ({ id: `${bank}-${balanceCheck}-${bankProduced}-${method}`, bank, method, status: "READ", balanceCheck, bankProduced, authenticityCodes: [] })

describe("textPassRate", () => {
  const outcomes = [o("NEDBANK", "PASS"), o("NEDBANK", "FAIL"), o("NEDBANK", "PASS", false), o("NEDBANK", "PASS", true, "VLM"), o("FNB", "PASS"), o("NEDBANK", "PASS", true, "SKIPPED")]

  it("counts TEXT passes over a bank's files, skipped files left out, vision reads counted as not passing", () => {
    expect(textPassRate(outcomes, true, ["NEDBANK"])).toEqual({ pass: 1, total: 3 })
    expect(textPassRate(outcomes, false, ["NEDBANK"])).toEqual({ pass: 2, total: 4 })
    expect(textPassRate(outcomes, true)).toEqual({ pass: 1, total: 1 })
  })

  it("gates Capitec, FNB, Nedbank and ABSA at 95%, and only reports Standard Bank and Discovery", () => {
    expect(TEXT_GATES).toEqual({ CAPITEC: 0.95, FNB: 0.95, NEDBANK: 0.95, ABSA: 0.95, STANDARD_BANK: null, DISCOVERY: null })
    expect(formatReport(outcomes)).toContain("| NEDBANK | 1/3 (33.3%) | 2/4 | ≥ 95% |")
  })
})

describe("outcomeOf", () => {
  const result = (bank: string, producer: string | null, creator: string | null): StatementAnalysisResult => ({
    method: "TEXT", status: "READ", bank: bank as StatementAnalysisResult["bank"], read: null, balanceCheck: "PASS", balanceDiffCents: 0,
    authenticity: { producer, creator, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: [] },
  })

  it("calls a file bank-produced only when producer and creator both fit the bank's profile", () => {
    expect(outcomeOf("a", result("CAPITEC", "OpenPDF 2.0.2", null)).bankProduced).toBe(true)
    expect(outcomeOf("b", result("CAPITEC", "OpenPDF 2.0.2", "Microsoft Word")).bankProduced).toBe(false)
    expect(outcomeOf("c", result("NEDBANK", null, "OpenText Exstream Version 16.6.60 64-bit")).bankProduced).toBe(true)
    expect(outcomeOf("d", result("TYMEBANK", "anything", null)).bankProduced).toBe(false)
  })
})
