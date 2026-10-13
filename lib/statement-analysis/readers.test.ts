/**
 * The text readers against synthetic statements laid out like the banks'
 * own (fixtures/synthetic.ts). Runs the real poppler tools on real PDFs.
 */
import { describe, expect, it } from "vitest"
import { analyseStatement } from "./analyse"
import { syntheticStatement } from "./fixtures/dataset"
import { buildCapitecStatement, buildFnbStatement, type SynthStatement } from "./fixtures/synthetic"

const scenario = { start: "2026-07-01", undisclosedLoan: true, gambling: true, paydayLender: true, returnedDebit: true }

async function read(bank: "CAPITEC" | "FNB", s: SynthStatement) {
  const pdf = bank === "CAPITEC" ? await buildCapitecStatement(s) : await buildFnbStatement(s)
  return analyseStatement(Buffer.from(pdf), "application/pdf", { allowVlm: false })
}

describe.each(["CAPITEC", "FNB"] as const)("%s text reader", (bank) => {
  it("reads every row, the header facts and a passing balance check", async () => {
    const s = syntheticStatement({ ...scenario, bank })
    const r = await read(bank, s)
    expect(r).toMatchObject({ method: "TEXT", status: "READ", bank, balanceCheck: "PASS", balanceDiffCents: 0 })
    expect(r.read).toMatchObject({
      accountHolderName: "T TESTER",
      accountNumberLast4: "0001",
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      openingBalanceCents: 234_567,
    })
    expect(r.read!.transactions.map((t) => [t.date, t.amountCents])).toEqual(
      s.transactions.map((t) => [t.date, t.amountCents + (t.feeCents ?? 0)]),
    )
    expect(r.authenticity.incrementalUpdates).toBe(0)
  })

  it("spans pages: rows past the first page keep their page numbers", async () => {
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
    const pdf = bank === "CAPITEC"
      ? await buildCapitecStatement(s, { misprint: { index: 3, amountCents: -1_000 } })
      : await buildFnbStatement(s, { misprint: { index: 3, amountCents: -1_000 } })
    const doctored = await analyseStatement(Buffer.from(pdf), "application/pdf", { allowVlm: false })
    expect(doctored.balanceCheck).toBe("FAIL")
  })
})

describe("analyseStatement routing", () => {
  it("defers a statement that needs the vision reader when the caller cannot wait", async () => {
    await expect(analyseStatement(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg", { allowVlm: false })).rejects.toThrow("deferred")
  })
})

describe("FNB rows that move no money", () => {
  it("reads a collection attempt as non-posting, keeps the balance check passing, and still raises the returned debit", async () => {
    const s = syntheticStatement({ bank: "FNB", start: "2026-07-01", collectionAttempt: true })
    const r = await read("FNB", s)
    expect(r.balanceCheck).toBe("PASS")
    const attempt = r.read!.transactions.find((t) => t.description.startsWith("EDO Collection Attempt"))
    expect(attempt).toMatchObject({ nonPosting: true, amountCents: 125_000 })
    const { riskBehaviour } = await import("@/lib/credit-checks/risk-behaviour")
    const flags = riskBehaviour({
      applicationId: "app", applicationDate: "2026-10-05", clientName: "T Tester", monthlyIncomeCents: 1_845_000, payslip: null, debts: [], deletedStatementIds: [], mismatchedPayslipIds: [], unreadPayslipIds: [], deletedPayslipIds: [], priorOpenFlagApplicationIds: [],
      statements: [{ documentId: "d", analysisId: "a", contentSha256: "s", state: "READ", method: "TEXT", bank: "FNB", read: r.read, balanceCheck: r.balanceCheck, authenticity: r.authenticity }],
    })
    expect(flags.map((f) => f.code)).toContain("RETURNED_DEBIT")
  })

  it("does not treat a row as non-posting for the word alone when it moved the balance", async () => {
    const s = syntheticStatement({ bank: "FNB", start: "2026-07-01" })
    s.transactions.push({ date: "2026-09-29", description: "Payment To: ATTEMPT 3 BETS", amountCents: -20_000 })
    const r = await read("FNB", s)
    expect(r.balanceCheck).toBe("PASS")
    expect(r.read!.transactions.find((t) => t.description.includes("ATTEMPT"))?.nonPosting).toBeUndefined()
  })

  it("dates rows across a year end from the statement period", async () => {
    const r = await read("FNB", syntheticStatement({ bank: "FNB", start: "2026-11-01" }))
    expect(r.balanceCheck).toBe("PASS")
    const months = new Set(r.read!.transactions.map((t) => t.date.slice(0, 7)))
    expect([...months]).toEqual(["2026-11", "2026-12", "2027-01"])
  })
})
