import { describe, expect, it } from "vitest"
import { CLIENT_JOURNAL_DEALS, day, type JournalDeal } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { LEASE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-lease-deals"
import { RECOVERY_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-recovery-deals"
import { CREDIT_NOTE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-credit-note-deals"
import { defaultAccounts, ledger, loan as consumerLoan, runWith } from "./derive.test-helpers"
import { RECEIVABLE_ROLES } from "./accounts"
import { desiredSources, deriveEntries } from "./derive"
import { parsePeriodKey } from "./period"
import { loanSources, type Vector } from "./sources"
import { creditShares } from "./sources-asset-finance"

const DEALS: JournalDeal[] = [...INSTALMENT_JOURNAL_DEALS, ...LEASE_JOURNAL_DEALS, ...RECOVERY_JOURNAL_DEALS, ...CREDIT_NOTE_JOURNAL_DEALS]
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
    expect(inception.eventDate).toEqual(new Date("2026-07-15T09:00:00+02:00")) // the payout release, not the invoice day
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
    expect(keys.filter((k) => /^(af|lease|lease-rental|lease-invoice|mf|af-recovery:)/.test(k))).toEqual([])
  })

  it("a lease's rentals and an instalment sale's rows never use the consumer loan book", () => {
    for (const deal of DEALS) {
      for (const s of loanSources(deal.loan, day(deal.asOf))) expect(s.vector.LOAN_BOOK, `${deal.id} ${s.baseKey}`).toBeUndefined()
    }
  })
})

describe("a credit note spread over the income its invoice credited", () => {
  const note = (exclVatCents: number, parts: number[]) => ({
    id: "cn", invoiceId: "inv", issueDate: day("2026-10-01"), exclVatCents, vatCents: 0, inclVatCents: exclVatCents,
    invoiceIncome: parts.map((p, i) => ({ role: (["RENTAL_INCOME", "MAINTENANCE_INCOME", "ASSET_DISPOSAL_PROCEEDS"] as const)[i], exclVatCents: p })),
  })

  it("adds up to the credit to the cent whatever the rounding, never negative", () => {
    for (let credit = 1; credit <= 400; credit += 1) {
      for (const parts of [[100_000, 20_000], [1, 1, 1], [333, 667], [7, 0, 13]]) {
        const total = parts.reduce((a, b) => a + b, 0)
        if (credit > total) continue
        const shares = creditShares(note(credit, parts))
        expect(shares.reduce((a, s) => a + s.cents, 0), `${credit} over ${parts}`).toBe(credit)
        expect(shares.every((s) => s.cents >= 0)).toBe(true)
      }
    }
  })

  it("gives the leftover cent to the larger remainder (hand-worked: 100 over 100 000 and 20 000 is 83 and 17)", () => {
    expect(creditShares(note(100, [100_000, 20_000]))).toEqual([{ role: "RENTAL_INCOME", cents: 83 }, { role: "MAINTENANCE_INCOME", cents: 17 }])
  })

  it("posts nothing before the credit note is issued and nothing for an invoice with no income", () => {
    expect(creditShares(note(100, [0, 0]))).toEqual([])
    const deal = LEASE_JOURNAL_DEALS[0]
    const early = loanSources(deal.loan, day("2026-09-20")).find((s) => s.baseKey === "lease-credit:cn-ls-a")!
    expect(Object.keys(nonEmpty(early.vector))).toEqual([])
  })
})

describe("recoveries: what the debtor pays and what reaches profit and loss", () => {
  const pnl = (deal: JournalDeal) => {
    const v = loanSources(deal.loan, day(deal.asOf)).reduce((sum, s) => sum + (s.vector.RECOVERY_COST_EXPENSE ?? 0) + (s.vector.RECOVERY_COSTS_RECHARGED ?? 0) + (s.vector.RECOVERY_RESULT ?? 0), 0)
    return v
  }
  const [SHORT, SURPLUS, SURPLUS_CHARGED] = RECOVERY_JOURNAL_DEALS

  it("a cost charged to the account never moves profit, whichever way it is recovered: 40 500 = output VAT 120 000 - input VAT 75 000 + 1 500 + 3 000", () => {
    // shortfall: expense 20 000 - recharge 23 000 + result 43 500; surplus: expense 20 000 + result 20 500 (no recharge, the cost is withheld from the refund)
    expect(pnl(SHORT)).toBe(40_500)
    expect(pnl(SURPLUS_CHARGED)).toBe(40_500)
    // without a charged cost: output VAT 120 000 - 75 000 - 1 500
    expect(pnl(SURPLUS)).toBe(43_500)
  })

  it("the debtor is charged once: a settled loan has no recovery-cost charge, and the cost is withheld from the refund", () => {
    expect(SURPLUS_CHARGED.loan.charges).toEqual([])
    const sources = loanSources(SURPLUS_CHARGED.loan, day(SURPLUS_CHARGED.asOf))
    expect(sources.filter((s) => s.baseKey.includes(":charge:"))).toEqual([])
    // surplus = net 908 500 - settlement 600 000 - charged 23 000, and the refund released is that surplus
    expect(SURPLUS_CHARGED.loan.assetFinance!.recoveries[0].surplusCents).toBe(908_500 - 600_000 - 23_000)
    const cash = sources.reduce((sum, s) => sum + (s.vector.BANK ?? 0), 0)
    // bank: +920 000 sale - 285 500 refund = 634 500; the suppliers (11 500 + 23 000) are paid through payables, outside the export
    expect(cash).toBe(920_000 - 285_500)
    expect(sources.reduce((sum, s) => sum + (s.vector.RECOVERY_COSTS_PAYABLE ?? 0), 0)).toBe(-(11_500 + 23_000))
    expect(sources.reduce((sum, s) => sum + (s.vector.AF_INSTALMENT_DEBTORS ?? 0), 0)).toBe(-600_000)
  })
})

describe("instalment-sale inception posts when the supplier is paid", () => {
  const deal = INSTALMENT_JOURNAL_DEALS[0]
  const inceptionAt = (asOf: string, releasedAt: Date) => {
    const af = deal.loan.assetFinance!
    const loan = { ...deal.loan, assetFinance: { ...af, payout: { amountCents: 950_000, releasedAt } } }
    return loanSources(loan, day(asOf)).find((s) => s.baseKey === "af:jrn-is-1:inception")!
  }

  it("is dated by the payout's release, not the invoice's supply date", () => {
    // invoice supplied 2026-07-15, payout released 2026-08-03: nothing posts in July, all of it in August
    const released = new Date("2026-08-03T09:00:00+02:00")
    expect(Object.keys(nonEmpty(inceptionAt("2026-08-01", released).vector))).toEqual([])
    expect(nonEmpty(inceptionAt("2026-09-01", released).vector)).toEqual(deal.expected["af:jrn-is-1:inception"])
    expect(inceptionAt("2026-09-01", released).origin.date).toEqual(released)
  })

  it("has not posted when no payout was released", () => {
    const loan = { ...deal.loan, assetFinance: { ...deal.loan.assetFinance!, payout: null } }
    const inception = loanSources(loan, day("2026-12-01")).find((s) => s.baseKey === "af:jrn-is-1:inception")!
    expect(Object.keys(nonEmpty(inception.vector))).toEqual([])
  })
})

describe("VAT stays explicit on asset-finance contracts", () => {
  it("never splits fee VAT out of a VAT-inclusive fee account, while a consumer loan's fee still splits", () => {
    const accounts = defaultAccounts([{ role: "FEE_INCOME", accountCode: "4010", accountName: null, taxCode: null, vatInclusive: true }])
    const vat = { registered: true, rateBps: 1500 }
    const october = parsePeriodKey("2026-10")!
    const lines = runWith(accounts, vat, [INSTALMENT_JOURNAL_DEALS[0].loan], october).find((e) => e.baseKey === "af:jrn-is-1:inception")!.lines
    // the financed fees 50 000 are one gross credit; OUTPUT_VAT is only the invoice's own 150 000
    expect(lines.filter((l) => l.role === "FEE_INCOME").map((l) => [l.creditCents, l.sourceRole])).toEqual([[50_000, null]])
    expect(lines.filter((l) => l.role === "OUTPUT_VAT").map((l) => [l.creditCents, l.sourceRole])).toEqual([[150_000, null]])
    const consumer = runWith(accounts, vat, [consumerLoan({ id: "c-1", upfrontFee: true, initiationFee: 10_000 })], parsePeriodKey("2026-08")!)
    expect(consumer.flatMap((e) => e.lines).some((l) => l.role === "OUTPUT_VAT" && l.sourceRole === "FEE_INCOME")).toBe(true)
  })
})

describe("credit notes the sources cannot spread", () => {
  it("post nothing, instead of an entry that does not balance", () => {
    const deal = LEASE_JOURNAL_DEALS[0]
    const af = deal.loan.assetFinance!
    const orphan = { id: "cn-orphan", invoiceId: "inv-x", issueDate: day("2026-10-05"), exclVatCents: 100, vatCents: 15, inclVatCents: 115, invoiceIncome: [] }
    const loan = { ...deal.loan, assetFinance: { ...af, creditNotes: [orphan] } }
    const sources = loanSources(loan, day(deal.asOf))
    expect(Object.keys(nonEmpty(sources.find((s) => s.baseKey === "lease-credit:cn-orphan")!.vector))).toEqual([])
    for (const s of sources) expect(sum(s.vector), s.baseKey).toBe(0)
  })

  it("spread a credit on a deficit-billing invoice into the fund liability as well", () => {
    // invoice 25 000 excl: deficit 15 000 + usage 10 000; a credit of 5 000 is 3 000 liability and 2 000 rental income
    const note = { id: "cn", invoiceId: "inv", issueDate: day("2026-10-20"), exclVatCents: 5_000, vatCents: 750, inclVatCents: 5_750, invoiceIncome: [
      { role: "ASSET_DISPOSAL_PROCEEDS" as const, exclVatCents: 0 }, { role: "MAINTENANCE_FUND_LIABILITY" as const, exclVatCents: 15_000 }, { role: "RENTAL_INCOME" as const, exclVatCents: 10_000 },
    ] }
    expect(creditShares(note)).toEqual([{ role: "MAINTENANCE_FUND_LIABILITY", cents: 3_000 }, { role: "RENTAL_INCOME", cents: 2_000 }])
  })
})

describe("a contract held back from a preview", () => {
  it("is not reversed as a removed source (its earlier postings stand), unless it is simply gone", () => {
    const deal = INSTALMENT_JOURNAL_DEALS[0]
    const state = ledger()
    runWith(defaultAccounts(), null, [deal.loan], parsePeriodKey("2026-10")!, state)
    const owners = new Map([...state.posted.keys()].map((k) => [k, { loanId: deal.loan.id, reference: deal.loan.reference }]))
    const next = (heldBack?: ReadonlySet<string>) => deriveEntries({
      loans: [], period: parsePeriodKey("2026-11")!, posted: state.posted, postedKeys: state.keys, postedLoans: owners, accounts: defaultAccounts(), heldBack,
    })
    expect(next(new Set([deal.loan.id]))).toEqual([])
    expect(next().length, "without the hold the sources are reversed as removed").toBeGreaterThan(0)
  })
})
