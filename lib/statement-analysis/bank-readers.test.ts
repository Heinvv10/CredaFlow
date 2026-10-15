/**
 * The Nedbank, ABSA, Standard Bank and Discovery text readers against
 * synthetic statements laid out like the banks' own
 * (fixtures/synthetic-banks.ts). Real poppler on real PDFs.
 */
import { describe, expect, it } from "vitest"
import { analyseStatement } from "./analyse"
import { syntheticStatement, type SynthBank } from "./fixtures/dataset"
import { buildStatement, DETECTED_AS } from "./fixtures/synthetic-banks"
import type { BuildOptions, SynthStatement } from "./fixtures/synthetic"
import { readNedbank } from "./nedbank"
import { splitFigures } from "./word-table"

const scenario = { start: "2026-07-01", undisclosedLoan: true, gambling: true, paydayLender: true, returnedDebit: true }
const BANKS = ["NEDBANK", "ABSA", "ABSA_ESTATEMENT", "STANDARD_BANK", "DISCOVERY"] as const

async function read(bank: SynthBank, s: SynthStatement, opts: BuildOptions = {}) {
  return analyseStatement(Buffer.from(await buildStatement(bank, s, opts)), "application/pdf", { allowVlm: false })
}

describe.each(BANKS)("%s text reader", (bank) => {
  it("reads every row, the header facts and a passing balance check", async () => {
    const s = syntheticStatement({ ...scenario, bank })
    const r = await read(bank, s)
    expect(r).toMatchObject({ method: "TEXT", status: "READ", bank: DETECTED_AS[bank], balanceCheck: "PASS", balanceDiffCents: 0 })
    expect(r.read).toMatchObject({
      accountHolderName: bank === "ABSA_ESTATEMENT" ? null : "T TESTER",
      accountNumberLast4: "0001",
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      openingBalanceCents: 234_567,
    })
    expect(r.read!.transactions.map((t) => [t.date, t.amountCents])).toEqual(s.transactions.map((t) => [t.date, t.amountCents]))
    expect(r.read!.transactions.map((t) => t.description)).toEqual(s.transactions.map((t) => expect.stringContaining(t.description)))
    expect(r.authenticity.incrementalUpdates).toBe(0)
  })

  it("spans pages: rows past the first page keep their page numbers and the balance holds", async () => {
    const long = syntheticStatement({ ...scenario, bank })
    long.transactions = Array.from({ length: 4 }, () => long.transactions).flat()
      .map((t) => ({ ...t })).sort((a, b) => a.date.localeCompare(b.date))
    const r = await read(bank, long)
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions).toHaveLength(long.transactions.length)
    expect(new Set(r.read!.transactions.map((t) => t.page)).size).toBeGreaterThan(1)
  })

  it("fails the balance check on a row printed with a different amount", async () => {
    const s = syntheticStatement({ ...scenario, bank })
    const r = await read(bank, s, { misprint: { index: 3, amountCents: -1_000 } })
    expect(r.balanceCheck).toBe("FAIL")
  })

  it("dates rows across a year end", async () => {
    const r = await read(bank, syntheticStatement({ bank, start: "2026-11-01" }))
    expect(r.balanceCheck).toBe("PASS")
    expect([...new Set(r.read!.transactions.map((t) => t.date.slice(0, 7)))]).toEqual(["2026-11", "2026-12", "2027-01"])
  })

  it("reads an overdrawn balance as negative", async () => {
    const s = syntheticStatement({ bank, start: "2026-07-01" })
    s.openingCents = -50_000
    const r = await read(bank, s)
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.openingBalanceCents).toBe(-50_000)
    expect(r.read!.transactions[0].balanceCents).toBe(-50_000 - 84_550)
  })
})

describe("statements that print no opening balance (ABSA, Discovery)", () => {
  // The opening is derived from the first row (balance − amount), so that one
  // row cannot be checked: a misprint there leaves the arithmetic whole. Every
  // later row is still checked against the running balance.
  it.each(["ABSA", "DISCOVERY"] as const)("%s: a misprint on the first row is not detectable by arithmetic", async (bank) => {
    const r = await read(bank, syntheticStatement({ bank, start: "2026-07-01" }), { misprint: { index: 0, amountCents: -94_550 } })
    expect(r.balanceCheck).toBe("PASS")
  })
})

describe("ABSA fees printed but not levied", () => {
  const withRows = (bank: SynthBank, extra: SynthStatement["transactions"]) => {
    const s = syntheticStatement({ bank, start: "2026-07-01" })
    s.transactions = [...s.transactions, ...extra].sort((a, b) => a.date.localeCompare(b.date))
    return s
  }

  it.each(["ABSA", "ABSA_ESTATEMENT"] as const)("%s: a pending or declined fee that leaves the balance unmoved is non-posting", async (bank) => {
    const s = withRows(bank, [
      { date: "2026-08-10", description: "NOTIFICATION FEE ( PENDING )", amountCents: -2_500, nonPosting: true },
      { date: "2026-08-11", description: "DECLINED FEE SYNTH", amountCents: -450, nonPosting: true },
    ])
    const r = await read(bank, s)
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions.filter((t) => t.nonPosting).map((t) => t.amountCents)).toEqual([-2_500, -450])
  })

  it("does not skip a row for the word alone when it moved the balance", async () => {
    const r = await read("ABSA", withRows("ABSA", [{ date: "2026-08-10", description: "PAYMENT TO (PENDING) SYNTH", amountCents: -2_500 }]))
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions.find((t) => t.description.includes("PENDING"))?.nonPosting).toBeUndefined()
  })
})

describe("Nedbank's Fees column", () => {
  it("is an accrual: a fee printed there is not part of the row's amount", async () => {
    const s = syntheticStatement({ bank: "NEDBANK", start: "2026-07-01" })
    s.transactions[2] = { ...s.transactions[2], accruedFeeCents: -1_250 }
    const r = await read("NEDBANK", s)
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions[2].amountCents).toBe(s.transactions[2].amountCents)
  })
})

describe("ABSA eStatement: a marked row without a printed balance", () => {
  it("stays posting when the next printed balance includes it", async () => {
    const s = syntheticStatement({ bank: "ABSA_ESTATEMENT", start: "2026-07-01" })
    // A real payment whose reference happens to say "(PENDING)": it moved the money.
    s.transactions = [...s.transactions, { date: "2026-08-10", description: "PAYMENT REF (PENDING) SYNTH", amountCents: -2_500 }]
      .sort((a, b) => a.date.localeCompare(b.date))
    const r = await read("ABSA_ESTATEMENT", s)
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions.find((t) => t.description.includes("PENDING"))?.nonPosting).toBeUndefined()
  })
})

describe("hostile word boxes", () => {
  it("skips an over-long line of adjacent figure-like words quickly", () => {
    const line = Array.from({ length: 50_000 }, (_, i) => ({ text: i % 2 ? "234.56" : "1", xMin: i * 2, xMax: i * 2 + 1.5, yMin: 0 }))
    const started = performance.now()
    expect(splitFigures(line, () => true).figures).toEqual([])
    const short = line.slice(0, 150)
    expect(splitFigures(short, (t) => /^\d+(?: \d+)*\.\d{2}$/.test(t)).figures.length).toBeGreaterThan(0)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe("hostile long lines", () => {
  // The account number is read from the line after its label: a long run of
  // digits there made the pattern quadratic before that line was bounded.
  it("reads a Nedbank page with a very long line quickly and takes nothing from it", () => {
    const started = performance.now()
    const page = `Statement period: 01/07/2026 – 30/09/2026\nOpening balance R1.00\n  Account type   Account number\n${"1".repeat(30_000)}x`
    expect(readNedbank([page], [[]])?.accountNumberLast4).toBeNull()
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
