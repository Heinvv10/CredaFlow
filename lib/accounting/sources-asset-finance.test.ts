import { describe, expect, it } from "vitest"
import { CLIENT_JOURNAL_DEALS, day, type JournalDeal } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { LEASE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-lease-deals"
import { RECOVERY_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-recovery-deals"
import { defaultAccounts, ledger, loan as consumerLoan, runWith } from "./derive.test-helpers"
import { RECEIVABLE_ROLES } from "./accounts"
import { desiredSources } from "./derive"
import { parsePeriodKey } from "./period"
import { loanSources, type Vector } from "./sources"

const DEALS: JournalDeal[] = [...INSTALMENT_JOURNAL_DEALS, ...LEASE_JOURNAL_DEALS, ...RECOVERY_JOURNAL_DEALS]
const nonEmpty = (v: Vector) => Object.fromEntries(Object.entries(v).filter(([, cents]) => cents !== 0))
const sum = (v: Vector) => Object.values(v).reduce((s, c) => s + (c ?? 0), 0)

function vectorsOf(deal: JournalDeal, asOf = deal.asOf): Record<string, Vector> {
  return Object.fromEntries(loanSources(deal.loan, day(asOf)).filter((s) => Object.keys(nonEmpty(s.vector)).length > 0).map((s) => [s.baseKey, nonEmpty(s.vector)]))
}

describe("asset-finance journal sources against the hand-worked deals", () => {
  it.skipIf(CLIENT_JOURNAL_DEALS.length > 0)("has no client deal pack yet (CLIENT_JOURNAL_DEALS is empty until the client supplies one)", () => {
    expect(CLIENT_JOURNAL_DEALS).toEqual([])
  })

  it.each(DEALS.map((d) => [d.id, d] as const))("%s: every source is the hand-worked vector to the cent", (_id, deal) => {
    const expected = Object.fromEntries(Object.entries(deal.expected).map(([k, v]) => [k, nonEmpty(v)]).filter(([, v]) => Object.keys(v).length > 0))
    expect(vectorsOf(deal)).toEqual(expected)
  })

  it.each(DEALS.map((d) => [d.id, d] as const))("%s: every vector sums to zero and the receivable is the worked figure", (_id, deal) => {
    const sources = loanSources(deal.loan, day(deal.asOf))
    for (const s of sources) expect(sum(s.vector), s.baseKey).toBe(0)
    const receivable = sources.reduce((total, s) => total + RECEIVABLE_ROLES.reduce((t, r) => t + (s.vector[r] ?? 0), 0), 0)
    expect(receivable).toBe(deal.receivableCents)
  })

  it.each(DEALS.map((d) => [d.id, d] as const))("%s: nothing is desired before the contract exists", (_id, deal) => {
    expect(vectorsOf(deal, "2026-01-01")).toEqual({})
  })

  it("an instalment sale's balloon is principal already inside the financed amount and posts nothing of its own", () => {
    const deal = INSTALMENT_JOURNAL_DEALS[0]
    const total = (asOf: string) => Object.values(vectorsOf(deal, asOf)).reduce((t, v) => t + (v.AF_INSTALMENT_DEBTORS ?? 0), 0)
    // every row due, the one receipt applied: F 1 000 000 + all interest 28 564 - 400 000. The 200 000 balloon is not added.
    expect(total("2026-12-01")).toBe(1_028_564 - 400_000)
    const interest = Object.values(vectorsOf(deal, "2026-12-01")).reduce((t, v) => t - (v.INTEREST_INCOME ?? 0), 0)
    expect(interest).toBe(10_000 + 10_100 + 6_201 + 2_263)
  })

  it("a written-off instalment sale writes off exactly what the other sources leave on its receivable", () => {
    const base = INSTALMENT_JOURNAL_DEALS[0].loan
    const written = { ...base, status: "WRITTEN_OFF", writeOffAt: day("2026-10-20") }
    const sources = loanSources(written, day("2026-11-01"))
    const writeOff = sources.find((s) => s.baseKey === `loan:${base.id}:write-off`)!.vector
    // F 1 000 000 + rows due before the write-off (10 000 + 10 100 + 6 201) - the receipt 400 000 = 626 301
    expect(writeOff).toEqual({ BAD_DEBT_EXPENSE: 626_301, AF_INSTALMENT_DEBTORS: -626_301 })
    expect(sources.reduce((t, s) => t + (s.vector.AF_INSTALMENT_DEBTORS ?? 0), 0)).toBe(0)
  })
})

describe("asset-finance sources through the ledger delta", () => {
  const october = parsePeriodKey("2026-10")!
  const november = parsePeriodKey("2026-11")!

  it("posts the whole history of a contract that predates the first open month in that month, labelled by origin", () => {
    const deal = INSTALMENT_JOURNAL_DEALS[0]
    const entries = runWith(defaultAccounts(), null, [deal.loan], october)
    const inception = entries.find((e) => e.baseKey === "af:jrn-is-1:inception")!
    expect(inception).toMatchObject({ eventType: "ASSET_INCEPTION", postingDate: "2026-10-01", loanId: "jrn-is-1" })
    expect(inception.eventDate).toEqual(day("2026-07-15"))
    expect(inception.description).toContain("AF-IS-0001")
    expect(entries.find((e) => e.baseKey === "payment:pay-is1")).toMatchObject({ eventType: "RECEIPT", eventDate: new Date("2026-09-16T10:00:00+02:00"), postingDate: "2026-10-01" })
  })

  it("posts each event once: a second run of the same month, and the next month, find nothing new", () => {
    const deal = INSTALMENT_JOURNAL_DEALS[0]
    const state = ledger()
    const first = runWith(defaultAccounts(), null, [deal.loan], october, state)
    expect(first.length).toBeGreaterThan(0)
    expect(runWith(defaultAccounts(), null, [deal.loan], october, state)).toEqual([])
    // row 4 falls due on 11-15: only November posts it, with the 2 263 of interest it accrues
    const next = runWith(defaultAccounts(), null, [deal.loan], november, state)
    expect(next.map((e) => [e.baseKey, e.postingDate])).toEqual([["af:jrn-is-1:row:is1-r4", "2026-11-15"]])
    expect(next[0].lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([["AF_INSTALMENT_DEBTORS", 2_263, 0], ["INTEREST_INCOME", 0, 2_263]])
  })

  it("keeps consumer loans exactly as they were: no asset-finance source is created for them", () => {
    const keys = desiredSources([consumerLoan()], parsePeriodKey("2026-11")!.end).map((s) => s.baseKey)
    expect(keys.filter((k) => /^(af|lease|lease-rental|lease-invoice|mf|recovery:[^:]+:)/.test(k))).toEqual([])
  })

  it("a lease's rentals and an instalment sale's rows never use the consumer loan book", () => {
    for (const deal of DEALS) {
      for (const s of loanSources(deal.loan, day(deal.asOf))) expect(s.vector.LOAN_BOOK, `${deal.id} ${s.baseKey}`).toBeUndefined()
    }
  })
})
