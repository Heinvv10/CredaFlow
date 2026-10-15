/**
 * Bank detection: a statement's own header names its bank; a payee that names
 * another bank must not. Synthetic statements only ("T TESTER").
 */
import { describe, expect, it } from "vitest"
import { detectBank, detectBanks } from "./detect-bank"
import { analyseStatement } from "./analyse"
import { syntheticStatement } from "./fixtures/dataset"
import { absaLines, standardBankLines } from "./fixtures/synthetic-banks"
import { buildFnbStatement, fnbLines, type SynthStatement } from "./fixtures/synthetic"

const withPayee = (bank: "FNB" | "STANDARD_BANK" | "ABSA", description: string): SynthStatement => {
  const s = syntheticStatement({ bank, start: "2026-07-01" })
  s.transactions = [...s.transactions, { date: "2026-08-10", description, amountCents: -12_500 }].sort((a, b) => a.date.localeCompare(b.date))
  return s
}
const textOf = (pages: string[][]) => pages.map((p) => p.join("\n")).join("\n")

describe("a payee that names another bank", () => {
  it("does not make an FNB statement ambiguous: only FNB is marked", () => {
    const text = textOf(fnbLines(withPayee("FNB", "PAYMENT TO ABSA BANK SYNTH")))
    expect(detectBanks(text)).toEqual(["FNB"])
  })

  it("does not outrank the statement's own bank: Standard Bank with an fnb.co.za payee", () => {
    const text = textOf(standardBankLines(withPayee("STANDARD_BANK", "REFUND fnb.co.za SYNTH")))
    expect(detectBank(text)).toBe("STANDARD_BANK")
    expect(detectBanks(text)).toEqual(["STANDARD_BANK"])
  })

  it("still reads the FNB statement as FNB end to end", async () => {
    const pdf = await buildFnbStatement(withPayee("FNB", "PAYMENT TO ABSA BANK SYNTH"))
    const r = await analyseStatement(Buffer.from(pdf), "application/pdf", { allowVlm: false })
    expect(r).toMatchObject({ method: "TEXT", bank: "FNB", balanceCheck: "PASS" })
  })
})

describe("a header that names no bank", () => {
  it("falls back to the markers anywhere in the text (ABSA prints its domain in the footer)", () => {
    const text = textOf(absaLines(withPayee("ABSA", "TRANSFER TO First National Bank")))
    // Every bank marked is still tried in turn: the pipeline keeps the one whose reader reads.
    expect(detectBanks(text)).toEqual(["FNB", "ABSA"])
  })

  it("is null when no bank is named at all", () => {
    expect(detectBank("Account statement\n01 Jul  SYNTH PAYMENT   1,250.00   9,999.99\n")).toBeNull()
  })
})
