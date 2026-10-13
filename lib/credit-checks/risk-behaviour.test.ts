import { describe, expect, it } from "vitest"
import { riskBehaviour } from "./risk-behaviour"
import { codes, facts, statement, tx } from "./facts.test-helpers"

describe("riskBehaviour", () => {
  it("raises nothing on ordinary spending", () => {
    const s = statement([tx("2026-07-03", "Card Purchase: SYNTH MART", -40_000), tx("2026-07-25", "SALARY", 1_845_000)])
    expect(riskBehaviour(facts({ statements: [s] }))).toEqual([])
  })

  it("raises RETURNED_DEBIT for Capitec's insufficient-funds rows and FNB's collection attempts", () => {
    const capitec = statement([tx("2026-07-02", "DebiCheck Insufficient Funds Fee", -1_000), tx("2026-07-09", "Card Purchase", -100)])
    const out = riskBehaviour(facts({ statements: [capitec] }))
    expect(codes(out)).toEqual(["RETURNED_DEBIT"])
    expect(out[0].evidence).toMatchObject({ transactionIndexes: [0] })

    const fnb = statement([{ ...tx("2026-07-02", "EDO Collection Attempt SYNTHLEND", 50_000), nonPosting: true }], { bank: "FNB" })
    expect(codes(riskBehaviour(facts({ statements: [fnb] })))).toEqual(["RETURNED_DEBIT"])
  })

  it("raises GAMBLING when betting spend reaches 5% of monthly income, not below", () => {
    // Income R18 450/month over a three-month statement: 5% = R922.50/month = R2 767.50 in total.
    const at = statement([tx("2026-07-05", "Card Purchase: HOLLYWOODBETS", -276_750)])
    const out = riskBehaviour(facts({ statements: [at] }))
    expect(codes(out)).toEqual(["GAMBLING"])
    expect(out[0].evidence).toMatchObject({ monthlyCents: 92_250, transactionIndexes: [0] })
    const below = statement([tx("2026-07-05", "Card Purchase: HOLLYWOODBETS", -276_000)])
    expect(riskBehaviour(facts({ statements: [below] }))).toEqual([])
  })

  it("raises GAMBLING on any betting spend when income is unknown", () => {
    const s = statement([tx("2026-07-05", "Betway deposit", -1_000)])
    expect(codes(riskBehaviour(facts({ statements: [s], monthlyIncomeCents: null })))).toEqual(["GAMBLING"])
  })

  it("does not take a word containing a merchant name for the merchant", () => {
    const s = statement([tx("2026-07-05", "Card Purchase: CASINOVA PIZZA", -276_750)])
    expect(riskBehaviour(facts({ statements: [s] }))).toEqual([])
  })

  it("raises PAYDAY_LENDER once per lender, for credits (a loan paid out) and debits alike", () => {
    const s = statement([
      tx("2026-07-05", "Payment Received: LENDPLUS", 150_000),
      tx("2026-08-05", "DebiCheck Debit: LENDPLUS", -180_000),
      tx("2026-08-06", "Payment To: WONGA", -10_000),
    ])
    const out = riskBehaviour(facts({ statements: [s] }))
    expect(codes(out)).toEqual(["PAYDAY_LENDER", "PAYDAY_LENDER"])
    expect(out.find((c) => c.evidence.lender === "LENDPLUS")!.evidence).toMatchObject({ transactionIndexes: [0, 1] })
  })
})
