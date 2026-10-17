import { describe, expect, it } from "vitest"
import { counterpartyKey, undisclosedDebt } from "./undisclosed-debt"
import { codes, facts, statement, tx } from "./facts.test-helpers"

const lender = (amount = -125_000) => statement([
  tx("2026-07-01", "DebiCheck Debit: SYNTHLEND FINANCE 7731", amount),
  tx("2026-08-01", "DebiCheck Debit: SYNTHLEND FINANCE 7798", amount),
  tx("2026-09-01", "DebiCheck Debit: SYNTHLEND FINANCE 7802", amount),
])

describe("counterpartyKey", () => {
  it("strips the debit-order prefix, references and digits so each month's row groups together", () => {
    expect(counterpartyKey("DebiCheck Debit: SYNTHLEND FINANCE 7731")).toBe("SYNTHLEND FINANCE")
    expect(counterpartyKey("Magtape Debit SYNTHLEND FINANCE REF88123")).toBe("SYNTHLEND FINANCE")
  })
})

describe("undisclosedDebt", () => {
  it("raises UNDISCLOSED_DEBIT_ORDER for a credit-like debit order nobody declared", () => {
    const out = undisclosedDebt(facts({ statements: [lender()] }))
    expect(codes(out)).toEqual(["UNDISCLOSED_DEBIT_ORDER"])
    expect(out[0].evidence).toMatchObject({ counterparty: "SYNTHLEND FINANCE", transactionIndexes: [0, 1, 2], monthlyCents: 125_000 })
  })

  it("is satisfied by a declared debt with a similar name and an instalment within 10%", () => {
    const debts = [{ name: "Synthlend Finance", monthlyInstalmentCents: 135_000, source: "DECLARED" as const }]
    expect(undisclosedDebt(facts({ statements: [lender()], debts }))).toEqual([])
  })

  it("is satisfied by a bureau account just the same", () => {
    const debts = [{ name: "SYNTHLEND", monthlyInstalmentCents: 125_000, source: "BUREAU" as const }]
    expect(undisclosedDebt(facts({ statements: [lender()], debts }))).toEqual([])
  })

  it("is satisfied by the client's own loan with this lender: its debit order is no undisclosed debt", () => {
    const debts = [{ name: "Synthlend Finance (Pty) Ltd", monthlyInstalmentCents: 125_000, source: "LENDER" as const }]
    expect(undisclosedDebt(facts({ statements: [lender()], debts }))).toEqual([])
  })

  it("still raises when the declared instalment is more than 10% off the debit order", () => {
    const debts = [{ name: "Synthlend Finance", monthlyInstalmentCents: 100_000, source: "DECLARED" as const }]
    expect(codes(undisclosedDebt(facts({ statements: [lender()], debts })))).toEqual(["UNDISCLOSED_DEBIT_ORDER"])
  })

  it("is not satisfied by a debt to someone else that happens to cost the same", () => {
    const debts = [{ name: "Other Bank Card", monthlyInstalmentCents: 125_000, source: "DECLARED" as const }]
    expect(codes(undisclosedDebt(facts({ statements: [lender()], debts })))).toEqual(["UNDISCLOSED_DEBIT_ORDER"])
  })

  it("matches within 10% of the instalment, and not a cent beyond", () => {
    const debt = (cents: number) => [{ name: "Synthlend Finance", monthlyInstalmentCents: cents, source: "DECLARED" as const }]
    const debit = (cents: number) => statement([tx("2026-07-01", "DebiCheck Debit: SYNTHLEND FINANCE", -cents)])
    expect(undisclosedDebt(facts({ statements: [debit(110_000)], debts: debt(100_000) }))).toEqual([])
    expect(codes(undisclosedDebt(facts({ statements: [debit(110_001)], debts: debt(100_000) })))).toEqual(["UNDISCLOSED_DEBIT_ORDER"])
  })

  it("uses the median debit, so one odd month does not hide the instalment", () => {
    const s = statement([
      tx("2026-07-01", "DebiCheck Debit: SYNTHLEND FINANCE", -100_000),
      tx("2026-08-01", "DebiCheck Debit: SYNTHLEND FINANCE", -100_000),
      tx("2026-09-01", "DebiCheck Debit: SYNTHLEND FINANCE", -900_000),
    ])
    expect(undisclosedDebt(facts({ statements: [s] }))[0].evidence).toMatchObject({ monthlyCents: 100_000 })
  })

  it("ignores money from a lender and rows that moved no money", () => {
    const s = statement([
      tx("2026-07-03", "Payment Received: SYNTHLEND LOANS", 500_000),
      tx("2026-08-03", "Payment Received: SYNTHLEND LOANS", 500_000),
      { ...tx("2026-08-05", "EDO Collection Attempt SYNTHLEND FINANCE", -125_000), nonPosting: true },
    ])
    expect(undisclosedDebt(facts({ statements: [s] }))).toEqual([])
  })

  it("lets a three-letter provider match its own declared debt", () => {
    const s = statement([tx("2026-07-03", "DebiCheck Debit: MFC 0042", -300_000), tx("2026-08-03", "DebiCheck Debit: MFC 0043", -300_000)])
    const debts = [{ name: "MFC", monthlyInstalmentCents: 300_000, source: "BUREAU" as const }]
    expect(undisclosedDebt(facts({ statements: [s], debts }))).toEqual([])
  })

  it("raises for a listed credit provider even without a credit word in the description", () => {
    const s = statement([tx("2026-07-03", "DebiCheck Debit: MOBICRED 1", -40_000), tx("2026-08-03", "DebiCheck Debit: MOBICRED 2", -40_000)])
    expect(codes(undisclosedDebt(facts({ statements: [s] })))).toEqual(["UNDISCLOSED_DEBIT_ORDER"])
  })

  it("ignores recurring debits that are not credit-like", () => {
    const s = statement([tx("2026-07-03", "DebiCheck Debit: SYNTH GYM", -40_000), tx("2026-08-03", "DebiCheck Debit: SYNTH GYM", -40_000)])
    expect(undisclosedDebt(facts({ statements: [s] }))).toEqual([])
  })

  it("ignores a one-off payment that is neither a debit order nor recurring", () => {
    const s = statement([tx("2026-07-03", "Card Purchase: SYNTH FINANCE SHOP", -40_000)])
    expect(undisclosedDebt(facts({ statements: [s] }))).toEqual([])
  })

  it("counts a credit-like counterparty seen in two months as recurring without a debit-order marker", () => {
    const s = statement([tx("2026-07-03", "Payment To: SYNTHLEND LOANS", -40_000), tx("2026-08-03", "Payment To: SYNTHLEND LOANS", -40_000)])
    expect(codes(undisclosedDebt(facts({ statements: [s] })))).toEqual(["UNDISCLOSED_DEBIT_ORDER"])
  })
})
