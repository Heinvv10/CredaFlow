import { describe, expect, it } from "vitest"
import type { DerivedEntry } from "./derive"
import { UnbalancedJournalError, verifyBalanced } from "./verify"

function entry(key: string, lines: Array<[number, number]>): DerivedEntry {
  return {
    eventKey: key, baseKey: key, eventType: "ADJUSTMENT", eventDate: new Date(0), postingDate: "2026-09-01", loanId: null,
    reference: "R", description: "d",
    lines: lines.map(([debitCents, creditCents], i) => ({ role: i === 0 ? "BANK" : "LOAN_BOOK", accountCode: String(i), taxCode: null, debitCents, creditCents })),
  }
}

describe("verifyBalanced", () => {
  it("returns the batch totals when every entry balances", () => {
    expect(verifyBalanced([entry("a", [[500, 0], [0, 500]]), entry("b", [[0, 7], [7, 0]])])).toEqual({
      entryCount: 2, lineCount: 4, debitCents: BigInt(507), creditCents: BigInt(507),
    })
  })

  it("refuses an entry whose debits and credits differ", () => {
    expect(() => verifyBalanced([entry("a", [[500, 0], [0, 499]])])).toThrow(UnbalancedJournalError)
  })

  it("refuses a two-sided, negative, fractional or one-line entry", () => {
    expect(() => verifyBalanced([entry("a", [[5, 5], [0, 0]])])).toThrow(/whole positive debit or credit/)
    expect(() => verifyBalanced([entry("a", [[-5, 0], [0, -5]])])).toThrow(UnbalancedJournalError)
    expect(() => verifyBalanced([entry("a", [[0.5, 0], [0, 0.5]])])).toThrow(UnbalancedJournalError)
    expect(() => verifyBalanced([entry("a", [[5, 0]])])).toThrow(/at least one debit and one credit/)
  })
})
