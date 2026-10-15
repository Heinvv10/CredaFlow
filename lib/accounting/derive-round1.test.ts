import { describe, expect, it } from "vitest"
import { desiredSources } from "./derive"
import { openingEntry, openingPositions, positionsAsLedger } from "./opening"
import { parsePeriodKey } from "./period"
import { compareBooks, journalBook } from "./reconcile"
import { at, byType, defaultAccounts, ledger, loan, net, runWith } from "./derive.test-helpers"

const AUG = parsePeriodKey("2026-08")!
const SEP = parsePeriodKey("2026-09")!
const OCT = parsePeriodKey("2026-10")!
const accounts = defaultAccounts()
const payout = (o: { paidAt?: Date | null; returnedAt?: Date | null; attempt?: number; id?: string } = {}) => ({
  id: o.id ?? "po-1", attempt: o.attempt ?? 1, amountCents: 200_000, paidAt: o.paidAt ?? null, returnedAt: o.returnedAt ?? null,
})

describe("disbursement through the payout channel", () => {
  it("books the loan against payout clearing and posts nothing to the bank while unpaid or failed", () => {
    const entries = runWith(accounts, null, [loan({ payouts: [payout()] })], AUG)
    expect(net(entries)).toEqual({ LOAN_BOOK: 200_000, PAYOUT_CLEARING: -200_000 })
  })

  it("moves clearing to the bank when the payout is paid, and back when it is returned", () => {
    const state = ledger()
    const aug = runWith(accounts, null, [loan({ payouts: [payout({ paidAt: at("2026-08-06") })] })], AUG, state)
    expect(byType(aug, "PAYOUT_PAID")[0]).toMatchObject({ eventKey: "payout:po-1", postingDate: "2026-08-06" })
    expect(net(aug)).toEqual({ LOAN_BOOK: 200_000, PAYOUT_CLEARING: 0, BANK: -200_000 })
    const oct = runWith(accounts, null, [loan({ payouts: [payout({ paidAt: at("2026-08-06"), returnedAt: at("2026-10-02") })] })], OCT, state)
    expect(byType(oct, "PAYOUT_RETURNED")[0]).toMatchObject({ eventKey: "payout:po-1@2026-10", postingDate: "2026-10-02" })
    expect(net(byType(oct, "PAYOUT_RETURNED"))).toEqual({ BANK: 200_000, PAYOUT_CLEARING: -200_000 })
    expect(state.posted.get("payout:po-1")).toEqual({ PAYOUT_CLEARING: 0, BANK: 0 })
  })

  it("posts the paid attempt only, when a retry pays after a failure", () => {
    const entries = runWith(accounts, null, [loan({ payouts: [payout(), payout({ id: "po-2", attempt: 2, paidAt: at("2026-08-09") })] })], AUG)
    expect(net(byType(entries, "PAYOUT_PAID"))).toEqual({ PAYOUT_CLEARING: 200_000, BANK: -200_000 })
    expect(byType(entries, "PAYOUT_PAID")[0].baseKey).toBe("payout:po-2")
  })

  it("reverses everything the loan posted when its disbursement is reversed", () => {
    const state = ledger()
    runWith(accounts, null, [loan({ payouts: [payout()] })], AUG, state)
    runWith(accounts, null, [loan({ payouts: [payout()] })], SEP, state)
    const reversed = loan({ status: "CANCELLED", closedAt: at("2026-10-05"), reversedAt: at("2026-10-05"), payouts: [payout()] })
    const oct = runWith(accounts, null, [reversed], OCT, state)
    expect(oct.every((e) => e.eventType === "DISBURSEMENT_REVERSED")).toBe(true)
    let book = 0
    let clearing = 0
    for (const v of state.posted.values()) { book += v.LOAN_BOOK ?? 0; clearing += v.PAYOUT_CLEARING ?? 0 }
    expect({ book, clearing }).toEqual({ book: 0, clearing: 0 })
  })
})

describe("credit-life premium on write-off", () => {
  it("reverses the premium not collected AS AT the write-off, from the receipts then, not the row's current paid figure", () => {
    const paidBefore = { id: "p1", amount: 13_450, paymentMethod: "EFT", receivedAt: at("2026-09-10"), allocationStatus: "ALLOCATED" as const, reconciledAt: null, reversed: false, reversedAt: null }
    // The row's stored totalPaid says 0 (as it might after a later re-derivation); the receipt says otherwise.
    const written = loan({ status: "WRITTEN_OFF", writeOffAt: at("2026-10-15"), payments: [paidBefore] })
    const oct = runWith(accounts, null, [written], OCT)
    // R134.50 paid instalment 1's R100 interest, then R34.50 of its R69 fees: half the R20 premium was collected.
    expect(net(byType(oct, "WRITE_OFF"))).toEqual({ CREDIT_LIFE_PAYABLE: 1_000, BAD_DEBT_EXPENSE: 202_450, LOAN_BOOK: -203_450 })
  })
})

describe("VAT-inclusive fee income", () => {
  const vatAccounts = defaultAccounts([{ role: "FEE_INCOME", accountCode: "4010", accountName: null, taxCode: null, vatInclusive: true }])

  it("splits VAT out of fee income for a VAT-registered lender, and leaves it alone otherwise", () => {
    const state = ledger()
    runWith(vatAccounts, { registered: true, rateBps: 1500 }, [loan()], AUG, state)
    const sep = runWith(vatAccounts, { registered: true, rateBps: 1500 }, [loan()], SEP, state)
    // R49.00 of fees (R69 less the R20 premium) holds R6.39 VAT at 15%.
    expect(net(byType(sep, "INSTALMENT_DUE"))).toMatchObject({ FEE_INCOME: -4_261, OUTPUT_VAT: -639, INTEREST_INCOME: -10_000 })
    // The ledger still compares the gross fee: nothing is left to post.
    expect(runWith(vatAccounts, { registered: true, rateBps: 1500 }, [loan()], SEP, state)).toEqual([])
    expect(net(runWith(vatAccounts, { registered: false, rateBps: 1500 }, [loan()], SEP))).not.toHaveProperty("OUTPUT_VAT")
  })
})

describe("go-live opening entry", () => {
  it("carries balance-sheet positions and nets bank and profit history into opening equity", () => {
    const history = loan({ startDate: at("2026-07-01"), payments: [{ id: "p1", amount: 50_000, paymentMethod: "EFT", receivedAt: at("2026-07-20"), allocationStatus: "ALLOCATED", reconciledAt: null, reversed: false, reversedAt: null }],
      schedule: [{ id: "r1", installmentNo: 1, dueDate: at("2026-08-01"), interestDue: 10_000, feesDue: 6_900, creditLifePremiumDue: 2_000 }] })
    const positions = openingPositions([history], SEP)
    const entry = openingEntry(positions, SEP, accounts)!
    expect(entry).toMatchObject({ eventType: "OPENING", postingDate: "2026-09-01", eventKey: "opening:2026-09" })
    expect(net([entry])).toEqual({ LOAN_BOOK: 166_900, CREDIT_LIFE_PAYABLE: -2_000, OPENING_BALANCE_EQUITY: -164_900 })
    // September posts only what happens after go-live.
    const base = positionsAsLedger(positions)
    const sep = runWith(accounts, null, [history], SEP, { posted: base.posted, keys: base.postedKeys })
    expect(sep).toEqual([])
  })
})

describe("receipt split and the reconciliation control", () => {
  it("re-states a split over-payment from loan book to unallocated receipts without bank churn", () => {
    const state = ledger()
    const whole = { id: "p1", amount: 300_000, paymentMethod: "EFT", receivedAt: at("2026-09-10"), allocationStatus: "ALLOCATED" as const, reconciledAt: null, reversed: false, reversedAt: null }
    runWith(accounts, null, [loan({ payments: [whole] })], SEP, state)
    const split = [{ ...whole, amount: 216_900 }, { ...whole, id: "p2", amount: 83_100, allocationStatus: "UNAPPLIED" as const, parentPaymentId: "p1" }]
    const oct = runWith(accounts, null, [loan({ payments: split })], OCT, state)
    expect(oct.filter((e) => e.baseKey === "payment:p1").map((e) => e.eventType)).toEqual(["RECLASS"])
    expect(net(oct.filter((e) => e.baseKey === "payment:p1"))).toEqual({ LOAN_BOOK: 83_100, UNALLOCATED_RECEIPTS: -83_100 })
  })

  it("ties the journal's loan book to the independent figure per loan, and names the loans that differ", () => {
    const sources = desiredSources([loan()], SEP.end)
    const posted = new Map(sources.map((s) => [s.baseKey, s.vector]))
    const owners = new Map(sources.map((s) => [s.baseKey, { loanId: s.loanId, reference: s.reference }]))
    const journal = journalBook(posted, owners, [])
    expect(journal.get("loan-1")).toBe(216_900)
    expect(compareBooks(journal, new Map([["loan-1", { reference: "LN-0001", cents: 216_900 }]])).mismatches).toEqual([])
    expect(compareBooks(journal, new Map([["loan-1", { reference: "LN-0001", cents: 216_800 }]])).mismatches).toEqual([
      { loanId: "loan-1", reference: "LN-0001", journalCents: 216_900, bookCents: 216_800 },
    ])
  })
})
