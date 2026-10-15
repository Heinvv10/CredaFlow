/**
 * Money a provider paid out after the loan's disbursement was reversed (PR #89
 * round 3, lib/payouts/recovery.ts): the loan stays reversed, and the payout
 * clearing account carries the debit until the money is recovered.
 */
import { describe, expect, it } from "vitest"
import { parsePeriodKey } from "./period"
import { at, byType, defaultAccounts, ledger, loan, net, runWith } from "./derive.test-helpers"

const AUG = parsePeriodKey("2026-08")!
const OCT = parsePeriodKey("2026-10")!
const NOV = parsePeriodKey("2026-11")!
const accounts = defaultAccounts()
const failed = { id: "po-1", attempt: 1, amountCents: 200_000, paidAt: null, returnedAt: null }
const reversed = (recoveredAt: Date | null = null, withCase = true) => loan({
  status: "CANCELLED", closedAt: at("2026-10-05"), reversedAt: at("2026-10-05"), payouts: [failed],
  recoveries: withCase ? [{ id: "rc-1", attempt: 1, amountCents: 200_000, paidAt: at("2026-10-08"), recoveredAt }] : [],
})
const totals = (state: ReturnType<typeof ledger>) => {
  const out = { LOAN_BOOK: 0, PAYOUT_CLEARING: 0, BANK: 0 }
  for (const v of state.posted.values()) for (const k of Object.keys(out) as Array<keyof typeof out>) out[k] += v[k] ?? 0
  return out
}

describe("money paid out on a reversed loan", () => {
  it("leaves the debit in payout clearing, against the bank, from the day the money left until it is recovered", () => {
    const state = ledger()
    runWith(accounts, null, [loan({ payouts: [failed] })], AUG, state)
    const oct = runWith(accounts, null, [reversed()], OCT, state)
    expect(byType(oct, "PAYOUT_PAID")).toHaveLength(1)
    expect(byType(oct, "PAYOUT_PAID")[0]).toMatchObject({ eventKey: "recovery:rc-1", postingDate: "2026-10-08", loanId: "loan-1" })
    expect(net(byType(oct, "PAYOUT_PAID"))).toEqual({ PAYOUT_CLEARING: 200_000, BANK: -200_000 })
    // The reversal stands: nothing on the loan book.
    expect(totals(state)).toEqual({ LOAN_BOOK: 0, PAYOUT_CLEARING: 200_000, BANK: -200_000 })

    // Escalated, not yet back: nothing more is posted.
    const novOpen = runWith(accounts, null, [reversed()], NOV, ledger())
    expect(byType(novOpen, "PAYOUT_RECOVERED")).toHaveLength(0)
  })

  it("clears it when the funds come back, in the month they came back", () => {
    const state = ledger()
    runWith(accounts, null, [loan({ payouts: [failed] })], AUG, state)
    runWith(accounts, null, [reversed()], OCT, state)
    const nov = runWith(accounts, null, [reversed(at("2026-11-03"))], NOV, state)
    expect(byType(nov, "PAYOUT_RECOVERED")[0]).toMatchObject({ eventKey: "recovery:rc-1@2026-11", postingDate: "2026-11-03" })
    expect(net(nov)).toEqual({ BANK: 200_000, PAYOUT_CLEARING: -200_000 })
    expect(totals(state)).toEqual({ LOAN_BOOK: 0, PAYOUT_CLEARING: 0, BANK: 0 })
  })

  it("posts nothing for a reversed loan without a recovery case", () => {
    const state = ledger()
    runWith(accounts, null, [loan({ payouts: [failed] })], AUG, state)
    runWith(accounts, null, [reversed(null, false)], OCT, state)
    expect(totals(state)).toEqual({ LOAN_BOOK: 0, PAYOUT_CLEARING: 0, BANK: 0 })
  })
})
