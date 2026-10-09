import { describe, it, expect } from "vitest"
import { matchTransactions } from "./reconcile"
import type { CandidateLoan, ParsedStatementLine } from "./types"

const loanA: CandidateLoan = {
  loanId: "loanA", loanReference: "LN-0099", expectedInstalmentCents: 150000,
  clientNameTokens: ["sipho", "dlamini"], clientPhoneDigits: "0821234567",
  nextDueDate: new Date(Date.UTC(2026, 6, 12)),
}
const loanB: CandidateLoan = {
  loanId: "loanB", loanReference: "LN-0100", expectedInstalmentCents: 150000,
  clientNameTokens: ["thabo", "nkosi"], clientPhoneDigits: "0839876543",
  nextDueDate: new Date(Date.UTC(2026, 6, 12)),
}
function credit(ref: string, cents = 150000, counterparty = ""): ParsedStatementLine {
  return { postedDate: new Date(Date.UTC(2026, 6, 11)), valueDate: null, amountCents: cents,
    direction: "CREDIT", rawReference: ref, counterparty, balanceCents: null, bankTxnId: null }
}

describe("matchTransactions", () => {
  it("EXACT-matches on loan reference in the payment reference (HIGH)", () => {
    const [r] = matchTransactions([credit("LN-0099")], [loanA, loanB])
    expect(r).toMatchObject({ tier: "EXACT", confidence: "HIGH", matchedLoanId: "loanA" })
  })

  it("HEURISTIC-matches on installment amount + client name token (MEDIUM)", () => {
    const [r] = matchTransactions([credit("payment sipho", 150000)], [loanA, loanB])
    expect(r).toMatchObject({ tier: "HEURISTIC", confidence: "MEDIUM", matchedLoanId: "loanA" })
  })

  it("WEAK-matches on installment amount near the due date only (LOW)", () => {
    const [r] = matchTransactions([credit("random", 150000)], [loanA])
    expect(r).toMatchObject({ tier: "WEAK", confidence: "LOW", matchedLoanId: "loanA" })
  })

  it("returns NONE when two candidates are equally plausible (no guessing)", () => {
    const [r] = matchTransactions([credit("random", 150000)], [loanA, loanB])
    expect(r).toMatchObject({ tier: "NONE", matchedLoanId: null })
  })

  it("returns NONE for debit lines", () => {
    const debit = { ...credit("LN-0099", -5900), direction: "DEBIT" as const }
    const [r] = matchTransactions([debit], [loanA])
    expect(r.tier).toBe("NONE")
  })

  it("does not EXACT-match a sequential-number substring collision", () => {
    const loan1 = { ...loanA, loanId: "loan1", loanReference: "LN-1" }
    const loan10 = { ...loanB, loanId: "loan10", loanReference: "LN-10" }
    const [forTen] = matchTransactions([credit("LN-10")], [loan1, loan10])
    expect(forTen).toMatchObject({ tier: "EXACT", matchedLoanId: "loan10" })
    const [forOne] = matchTransactions([credit("LN-1")], [loan1, loan10])
    expect(forOne).toMatchObject({ tier: "EXACT", matchedLoanId: "loan1" })
  })

  it("returns NONE when two loan references both EXACT-match (no guess)", () => {
    const dup = { ...loanB, loanId: "loanDup", loanReference: "LN-0099" }
    const [r] = matchTransactions([credit("LN-0099")], [loanA, dup])
    expect(r).toMatchObject({ tier: "NONE", matchedLoanId: null })
  })

  it("returns NONE when two candidates both HEURISTIC-match (no guess)", () => {
    const [r] = matchTransactions([credit("from sipho and thabo", 150000)], [loanA, loanB])
    expect(r).toMatchObject({ tier: "NONE", matchedLoanId: null })
  })
})
