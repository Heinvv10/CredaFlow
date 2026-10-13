import { describe, expect, it } from "vitest"
import { bureauAccounts } from "./bureau-accounts"

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
