import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { computeInsights } from "@/lib/statement-analysis/insights"
import { syntheticTransactions } from "./synthetic.test-helpers"
import { allowedFrom, explanationFacts, safeKey, summaryFacts } from "./facts"
import { rand } from "./format"
import { postCheck } from "./post-check"
import { EXPLANATION_PROMPT_VERSION, explanationPrompt, SUMMARY_PROMPT_VERSION, summaryPrompt } from "./prompts"

const read = { periodStart: "2026-07-01", periodEnd: "2026-09-30", openingBalanceCents: 500_000, closingBalanceCents: null, accountHolderName: "T TESTER", accountNumberLast4: "0001", transactions: syntheticTransactions() }
const insights = computeInsights(
  [{ documentId: "doc-1", bank: "CAPITEC", balanceCheck: "PASS", read: read as never }],
  { clientName: "T TESTER", declaredExpensesCents: 400_000 },
)
const rows = read.transactions.map((t) => ({ t }))
const flags = [
  { code: "GAMBLING", check: "RISK_BEHAVIOUR" as const, evidence: { documentId: "doc-1", transactionIndexes: [2, 8, 14], monthlyCents: 150_000, monthlyIncomeCents: 1_845_000 } },
]

describe("rand", () => {
  it("writes amounts one way, cents included", () => {
    expect([rand(0), rand(5), rand(123_456), rand(-45_000), rand(100_000_000)]).toEqual(["R0.00", "R0.05", "R1 234.56", "-R450.00", "R1 000 000.00"])
  })
})

describe("summaryFacts", () => {
  const built = summaryFacts(insights, rows, flags)
  it("gives the model figures and masked payees, never the client's name or a summary", () => {
    const json = JSON.stringify(built.facts)
    expect(json).not.toContain("TESTER")
    expect(json).not.toContain("summary")
    expect(built.facts.topPayees.map((p) => p.payee)).toContain("SYNTH RENTALS")
    expect(built.facts.raisedFlags).toEqual([{ code: "GAMBLING", check: "RISK_BEHAVIOUR", evidenceRows: 3 }])
    expect(built.raisedFlagCodes).toEqual(["GAMBLING"])
  })
  it("allows exactly the figures it gives", () => {
    const rent = built.facts.topPayees.find((p) => p.payee === "SYNTH RENTALS")!
    expect(rent.moneyOut).toBe("R19 500.00")
    const text = `Rent to SYNTH RENTALS came to ${rent.moneyOut} over ${rent.payments} payments; GAMBLING was raised.`
    expect(postCheck({ text, allowed: built.allowed, raisedFlagCodes: built.raisedFlagCodes })).toEqual({ ok: true })
    expect(postCheck({ text: text.replace("R19 500.00", "R19 600.00"), allowed: built.allowed, raisedFlagCodes: built.raisedFlagCodes }).ok).toBe(false)
  })
  it("hashes the facts: other facts, another hash", () => {
    expect(built.inputHash).toBe(createHash("sha256").update(JSON.stringify(built.facts)).digest("hex"))
    expect(summaryFacts(insights, rows, []).inputHash).not.toBe(built.inputHash)
  })
})

describe("safeKey", () => {
  it("withholds payee names that read as a verdict or a figure", () => {
    expect(["SYNTH RENTALS", "PICK N PAY"].every(safeKey)).toBe(true)
    expect(["ALL FLAGS RESOLVED", "OK FOODS", "R FIVE", "PAY 50%", ""].some(safeKey)).toBe(false)
  })
})

describe("allowedFrom", () => {
  it("sorts every figure by kind; strings with digits are literals", () => {
    expect(allowedFrom({ a: "R1 234.56", b: "2026-09-25", c: "2026-09", d: 3, sharePercent: 12.5, e: "S1-R12" })).toEqual({
      amountsCents: [123_456], monthlyAmountsCents: [], dates: ["2026-09-25"], months: ["2026-09"], numbers: [3], percents: [12.5], literals: ["S1-R12"],
    })
  })
})

describe("explanationFacts", () => {
  it("cites rows by reference with masked payees and the policy threshold", () => {
    const built = explanationFacts(flags[0], [2, 8].map((index) => ({ statementRef: "S1", index, t: read.transactions[index] })), ["GAMBLING"])
    expect(built.facts.evidenceRows).toEqual([
      { ref: "S1-R2", date: "2026-07-12", payee: "HOLLYWOODBETS", amount: "-R1 500.00" },
      { ref: "S1-R8", date: "2026-08-12", payee: "HOLLYWOODBETS", amount: "-R1 500.00" },
    ])
    expect(built.facts.policyThresholds).toEqual({ gamblingShareOfIncomePercent: 5 })
    expect(built.facts.evidence).toMatchObject({ monthly: "R1 500.00", monthlyIncome: "R18 450.00" })
    const text = "GAMBLING: betting of R1 500.00 a month (rows S1-R2 and S1-R8) is above the policy threshold of 5% of income."
    expect(postCheck({ text, allowed: built.allowed, raisedFlagCodes: ["GAMBLING"] })).toEqual({ ok: true })
  })
})

describe("prompt versions", () => {
  // A prompt edit must bump its version (outputs are keyed by it). Re-pin the hash with the bump.
  const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)
  it("pins the summary prompt to its version", () => {
    expect([SUMMARY_PROMPT_VERSION, hash(summaryPrompt(summaryFacts(insights, rows, flags).facts))]).toEqual(["summary-p2", "ec9066f91ba85f77"])
  })
  it("pins the explanation prompt to its version", () => {
    const built = explanationFacts(flags[0], [], ["GAMBLING"])
    expect([EXPLANATION_PROMPT_VERSION, hash(explanationPrompt(built.facts))]).toEqual(["explain-p3", "802dc382c413f900"])
  })
})
