import { describe, expect, it } from "vitest"
import { deriveEntries } from "./derive"
import { parsePeriodKey } from "./period"
import type { SourceLoan } from "./sources"
import { verifyBalanced } from "./verify"
import { at, byType, defaultAccounts, ledger, loan, net, runWith, type TestPayment } from "./derive.test-helpers"

const accounts = defaultAccounts()
const AUG = parsePeriodKey("2026-08")!
const SEP = parsePeriodKey("2026-09")!
const OCT = parsePeriodKey("2026-10")!
const run = (loans: SourceLoan[], period = SEP, state = ledger()) => runWith(accounts, null, loans, period, state)

describe("journal derivation per money event", () => {
  it("disburses the full principal to the loan book (deferred fee)", () => {
    const entries = run([loan()], AUG)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ eventKey: "loan:loan-1:disbursement", eventType: "DISBURSEMENT", postingDate: "2026-08-05" })
    expect(net(entries)).toEqual({ LOAN_BOOK: 200_000, BANK: -200_000 })
  })

  it("books an upfront initiation fee as income and pays out the net advance", () => {
    expect(net(run([loan({ upfrontFee: true })], AUG))).toEqual({ LOAN_BOOK: 200_000, BANK: -190_000, FEE_INCOME: -10_000 })
  })

  it("raises interest, fees and the credit-life premium when the instalment falls due", () => {
    const state = ledger()
    run([loan()], AUG, state)
    const sep = run([loan()], SEP, state)
    const due = byType(sep, "INSTALMENT_DUE")
    expect(due).toHaveLength(1)
    expect(net(due)).toEqual({ LOAN_BOOK: 16_900, INTEREST_INCOME: -10_000, FEE_INCOME: -4_900, CREDIT_LIFE_PAYABLE: -2_000 })
    // Instalment 2 is due in October, not yet.
    expect(sep.some((e) => e.baseKey.endsWith("row-2"))).toBe(false)
  })

  it("raises default interest and default fees on their day", () => {
    const charges = [
      { type: "DEFAULT_INTEREST", day: at("2026-09-05"), amount: 300, sourceId: null },
      { type: "DEFAULT_ADMIN", day: at("2026-09-06"), amount: 5_000, sourceId: "s129-1" },
    ]
    const entries = byType(run([loan({ charges })]), "DEFAULT_CHARGE")
    expect(net(entries)).toEqual({ LOAN_BOOK: 5_300, DEFAULT_INTEREST_INCOME: -300, DEFAULT_FEE_INCOME: -5_000 })
  })

  it("credits a receipt to the loan book, an unapplied one to unallocated receipts", () => {
    const payments: TestPayment[] = [
      { id: "p1", amount: 50_000, paymentMethod: "EFT", receivedAt: at("2026-09-10"), allocationStatus: "ALLOCATED", reconciledAt: null, reversed: false, reversedAt: null },
      { id: "p2", amount: 7_000, paymentMethod: "EFT", receivedAt: at("2026-09-11"), allocationStatus: "UNAPPLIED", reconciledAt: null, reversed: false, reversedAt: null },
    ]
    const receipts = byType(run([loan({ payments })]), "RECEIPT")
    expect(receipts.map((e) => e.eventKey)).toEqual(["payment:p1", "payment:p2"])
    expect(net(receipts)).toEqual({ BANK: 57_000, LOAN_BOOK: -50_000, UNALLOCATED_RECEIPTS: -7_000 })
  })

  it("books a waiver as an expense, not cash", () => {
    const payments: TestPayment[] = [
      { id: "w1", amount: 75, paymentMethod: "WAIVER", receivedAt: at("2026-09-12"), allocationStatus: "ALLOCATED", reconciledAt: null, reversed: false, reversedAt: null },
    ]
    const waiver = byType(run([loan({ payments })]), "WAIVER")
    expect(net(waiver)).toEqual({ WAIVER_EXPENSE: 75, LOAN_BOOK: -75 })
  })

  it("reverses an exported receipt in the next period, under its own event key", () => {
    const state = ledger()
    const p = { id: "p1", amount: 50_000, paymentMethod: "EFT", receivedAt: at("2026-09-10"), allocationStatus: "ALLOCATED" as const, reconciledAt: null, reversed: false, reversedAt: null }
    run([loan({ payments: [p] })], SEP, state)
    const oct = run([loan({ payments: [{ ...p, reversed: true, reversedAt: at("2026-10-03") }] })], OCT, state)
    const reversal = byType(oct, "REVERSAL")
    expect(reversal).toHaveLength(1)
    expect(reversal[0]).toMatchObject({ eventKey: "payment:p1@2026-10", postingDate: "2026-10-03" })
    expect(net(reversal)).toEqual({ BANK: -50_000, LOAN_BOOK: 50_000 })
  })

  it("moves an unapplied receipt when it is later applied, or refunded", () => {
    const state = ledger()
    const base = { amount: 7_000, paymentMethod: "EFT", receivedAt: at("2026-09-11"), reversed: false, reversedAt: null }
    run([loan({ payments: [{ ...base, id: "a", allocationStatus: "UNAPPLIED", reconciledAt: null }, { ...base, id: "r", allocationStatus: "UNAPPLIED", reconciledAt: null }] })], SEP, state)
    const oct = run([loan({ payments: [
      { ...base, id: "a", allocationStatus: "ALLOCATED", reconciledAt: at("2026-10-02") },
      { ...base, id: "r", allocationStatus: "REFUNDED", reconciledAt: at("2026-10-04") },
    ] })], OCT, state)
    expect(net(byType(oct, "ALLOCATION"))).toEqual({ UNALLOCATED_RECEIPTS: 7_000, LOAN_BOOK: -7_000 })
    expect(net(byType(oct, "REFUND"))).toEqual({ UNALLOCATED_RECEIPTS: 7_000, BANK: -7_000 })
  })

  it("writes off what the loan book holds (uncollected premium back out of the payable), raises nothing after, books recoveries as recoveries", () => {
    const state = ledger()
    run([loan()], AUG, state)
    run([loan()], SEP, state)
    const payments: TestPayment[] = [
      { id: "late", amount: 1_000, paymentMethod: "EFT", receivedAt: at("2026-10-25"), allocationStatus: "ALLOCATED", reconciledAt: null, reversed: false, reversedAt: null },
    ]
    const oct = run([loan({ status: "WRITTEN_OFF", writeOffAt: at("2026-10-15"), payments })], OCT, state)
    expect(oct.some((e) => e.baseKey.endsWith("row-2"))).toBe(false)
    // Instalment 1's R20 premium was never collected: it is not owed to the insurer.
    expect(net(byType(oct, "WRITE_OFF"))).toEqual({ CREDIT_LIFE_PAYABLE: 2_000, BAD_DEBT_EXPENSE: 214_900, LOAN_BOOK: -216_900 })
    expect(net(byType(oct, "RECEIPT"))).toEqual({ BANK: 1_000, BAD_DEBT_RECOVERY: -1_000 })
    let book = 0
    for (const vector of state.posted.values()) book += vector.LOAN_BOOK ?? 0
    expect(book).toBe(0)
  })

  it("earns an early settlement's re-stated interest on the day the loan closed", () => {
    const settled = loan({ status: "COMPLETED", closedAt: at("2026-08-20") })
    settled.schedule = [{ ...settled.schedule[0], interestDue: 4_000 }]
    const entries = byType(run([settled], AUG), "INSTALMENT_DUE")
    expect(entries[0]).toMatchObject({ postingDate: "2026-08-20" })
    expect(net(entries)).toMatchObject({ INTEREST_INCOME: -4_000 })
  })
})

describe("periods, idempotency and corrections", () => {
  it("finds nothing more to post once a period's entries are in the ledger", () => {
    const state = ledger()
    const loans = [loan({ charges: [{ type: "DEFAULT_INTEREST", day: at("2026-09-05"), amount: 300, sourceId: null }] })]
    run(loans, AUG, state)
    expect(run(loans, SEP, state).length).toBeGreaterThan(0)
    expect(deriveEntries({ loans, period: SEP, posted: state.posted, postedKeys: state.keys, postedLoans: new Map(), accounts })).toEqual([])
  })

  it("derives identical entries from identical inputs", () => {
    const a = deriveEntries({ loans: [loan()], period: SEP, posted: new Map(), postedKeys: new Set(), postedLoans: new Map(), accounts })
    const b = deriveEntries({ loans: [loan()], period: SEP, posted: new Map(), postedKeys: new Set(), postedLoans: new Map(), accounts })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it("posts a receipt backdated into a closed month on the next month's first day", () => {
    const state = ledger()
    run([loan()], AUG, state)
    run([loan()], SEP, state)
    const late = { id: "bd", amount: 9_000, paymentMethod: "EFT", receivedAt: at("2026-09-20"), allocationStatus: "ALLOCATED" as const, reconciledAt: null, reversed: false, reversedAt: null }
    const [entry] = run([loan({ payments: [late] })], OCT, state).filter((e) => e.baseKey === "payment:bd")
    expect(entry).toMatchObject({ eventKey: "payment:bd", postingDate: "2026-10-01" })
    expect(entry.eventDate.toISOString()).toBe(at("2026-09-20").toISOString())
  })

  it("reverses a default charge the re-derivation removed", () => {
    const state = ledger()
    const charge = { type: "DEFAULT_INTEREST", day: at("2026-09-05"), amount: 300, sourceId: null }
    run([loan({ charges: [charge] })], SEP, state)
    const oct = run([loan({ charges: [] })], OCT, state)
    const adj = oct.filter((e) => e.eventType === "ADJUSTMENT")
    expect(adj).toHaveLength(1)
    expect(net(adj)).toEqual({ LOAN_BOOK: -300, DEFAULT_INTEREST_INCOME: 300 })
  })

  it("posts the difference when a stored instalment is re-stated after it was exported", () => {
    const state = ledger()
    run([loan()], SEP, state)
    const restated = loan()
    restated.schedule = [{ ...restated.schedule[0], interestDue: 8_000 }, restated.schedule[1]]
    const adj = run([restated], OCT, state).filter((e) => e.baseKey === "loan:loan-1:instalment:row-1")
    expect(adj[0].eventKey).toBe("loan:loan-1:instalment:row-1@2026-10")
    expect(net(adj)).toEqual({ LOAN_BOOK: -2_000, INTEREST_INCOME: 2_000 })
  })

  it("keeps every period balanced across a full lifecycle", () => {
    const state = ledger()
    const payments: TestPayment[] = [
      { id: "p1", amount: 100_000, paymentMethod: "EFT", receivedAt: at("2026-09-02"), allocationStatus: "ALLOCATED", reconciledAt: null, reversed: true, reversedAt: at("2026-10-01") },
      { id: "p2", amount: 7_000, paymentMethod: "EFT", receivedAt: at("2026-09-03"), allocationStatus: "REFUNDED", reconciledAt: at("2026-10-09"), reversed: false, reversedAt: null },
    ]
    for (const period of [AUG, SEP, OCT]) {
      const totals = verifyBalanced(run([loan({ payments, upfrontFee: true })], period, state))
      expect(totals.debitCents).toBe(totals.creditCents)
    }
  })
})
