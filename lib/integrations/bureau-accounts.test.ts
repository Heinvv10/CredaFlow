import { describe, expect, it } from "vitest"
import { bureauAccounts, bureauObligationRows, randAmountCents } from "./bureau-accounts"

describe("randAmountCents", () => {
  it("reads numbers and clean decimal strings; absent is zero; anything else is unknown", () => {
    expect([1250.5, "5000.00", " 12 ", "-3.5", undefined, null].map(randAmountCents)).toEqual([125_050, 500_000, 1_200, -350, 0, 0])
    expect(["R5,000", "5 000", "", "n/a", "1e3", Number.NaN, Infinity, {}, true].map(randAmountCents)).toEqual(Array(9).fill(null))
  })
})

describe("bureauObligationRows", () => {
  it("keeps every account: a nameless one as UNKNOWN, an unreadable amount as null", () => {
    const pick = (row: Record<string, unknown>) => ({ subscriber: row.s, accountType: null, instalmentRands: row.i, status: row.st })
    expect(bureauObligationRows([{ s: "", i: 10, st: "OPEN/ARREARS" }, { s: "A", i: "x" }], pick)).toEqual([
      { subscriber: "UNKNOWN", accountType: null, instalmentCents: 1_000, status: "OPEN/ARREARS" },
      { subscriber: "A", accountType: null, instalmentCents: null, status: null },
    ])
  })
})

const pick = (row: Record<string, unknown>) => ({ subscriber: row.s, accountType: row.t, instalmentRands: row.i, status: row.st })

describe("bureauAccounts", () => {
  it("maps rand instalments to cents and keeps type and status", () => {
    expect(bureauAccounts([{ s: " SYNTHLEND ", t: "PERSONAL LOAN", i: 1250.5, st: "OPEN/CURRENT" }], pick))
      .toEqual([{ subscriber: "SYNTHLEND", accountType: "PERSONAL LOAN", instalmentCents: 125_050, status: "OPEN/CURRENT" }])
  })

  it("drops an account with no subscriber, and reads a missing or non-finite instalment as zero", () => {
    expect(bureauAccounts([{ s: "", i: 10 }, { s: null, i: 10 }], pick)).toEqual([])
    expect(bureauAccounts([{ s: "A", i: Number.NaN }, { s: "B" }], pick).map((a) => a.instalmentCents)).toEqual([0, 0])
  })
})
