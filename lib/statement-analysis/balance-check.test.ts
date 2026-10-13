import { describe, expect, it } from "vitest"
import { checkBalance } from "./balance-check"
import type { StatementRead, StatementTransaction } from "./types"

const tx = (amountCents: number, balanceCents: number | null): StatementTransaction => ({
  date: "2026-01-02",
  description: "SYNTHETIC",
  amountCents,
  balanceCents,
  page: 1,
})

const read = (opening: number | null, closing: number | null, transactions: StatementTransaction[]): StatementRead => ({
  accountHolderName: null,
  accountNumberLast4: null,
  periodStart: null,
  periodEnd: null,
  openingBalanceCents: opening,
  closingBalanceCents: closing,
  transactions,
})

describe("checkBalance", () => {
  it("passes when opening plus every amount is the closing balance and each row follows", () => {
    const r = checkBalance(read(10000, 12500, [tx(5000, 15000), tx(-2500, 12500)]))
    expect(r).toEqual({ result: "PASS", diffCents: 0, breaks: [] })
  })

  it("tolerates one cent of rounding and no more", () => {
    expect(checkBalance(read(10000, 15001, [tx(5000, null)])).result).toBe("PASS")
    expect(checkBalance(read(10000, 15002, [tx(5000, null)]))).toEqual({ result: "FAIL", diffCents: -2, breaks: [] })
  })

  it("fails and names the row whose running balance does not follow from the one before", () => {
    // Row 1's amount was edited from -2500 to -500 without fixing its balance.
    const r = checkBalance(read(10000, 12500, [tx(5000, 15000), tx(-500, 12500), tx(0, 12500)]))
    expect(r.result).toBe("FAIL")
    expect(r.breaks).toEqual([1])
    expect(r.diffCents).toBe(2000)
  })

  it("fails on a running-balance break even when the totals happen to reconcile", () => {
    const r = checkBalance(read(0, 0, [tx(100, 100), tx(-100, 50), tx(0, 0)]))
    expect(r.result).toBe("FAIL")
    expect(r.breaks).toEqual([1, 2])
  })

  it("is not applicable without both an opening and a closing balance", () => {
    expect(checkBalance(read(null, 100, [tx(100, 100)])).result).toBe("NOT_APPLICABLE")
    expect(checkBalance(read(0, null, [tx(100, 100)])).result).toBe("NOT_APPLICABLE")
  })
})

describe("checkBalance with a non-posting row", () => {
  it("leaves a row the bank printed without posting out of both identities", () => {
    const attempt: StatementTransaction = { ...tx(70000, 15000), nonPosting: true }
    expect(checkBalance(read(10000, 15000, [tx(5000, 15000), attempt])).result).toBe("PASS")
  })
})
