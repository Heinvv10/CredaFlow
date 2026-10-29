/**
 * Dealer commission journals (slice 5 part A): the lines the database accrues
 * (EARNED on booking, REVERSED on clawback) and the payable runs released to
 * the dealer, as journal sources. Every expectation is worked by hand from
 * docs/asset-finance/SLICE5.md "Commission, runs and journals"; values are
 * synthetic. Dr is +, Cr is -.
 */
import { describe, expect, it } from "vitest"
import { day, INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { ACCOUNT_ROLES, ASSET_FINANCE_ROLES, DEFAULT_ACCOUNTS, NOT_CARRIED_AT_OPENING } from "./accounts"
import { defaultAccounts, ledger, net, runWith } from "./derive.test-helpers"
import { netByAccount, resolveChart } from "./isaflow/journal"
import type { GlAccountRow } from "./isaflow/contract"
import { openingEntry, openingPositions } from "./opening"
import { parsePeriodKey } from "./period"
import { loanSources, type SourceLoan, type Vector } from "./sources"
import type { SourceDealerCommission } from "./source-types"

const base = INSTALMENT_JOURNAL_DEALS[0].loan
const AUGUST = parsePeriodKey("2026-08")!

/** 1 000 000 × 250 bps + 150 000 flat = 175 000 net; a VAT vendor adds 15 %: 26 250; gross 201 250. */
const EARNED: SourceDealerCommission = { id: "dcl-1", kind: "EARNED", effectiveOn: day("2026-08-10"), netCents: 175_000, vatCents: 26_250, grossCents: 201_250, releasedAt: null }
/** The clawback: the exact negatives, dated the day the loan was written off. */
const REVERSED: SourceDealerCommission = { id: "dcl-2", kind: "REVERSED", effectiveOn: day("2026-10-20"), netCents: -175_000, vatCents: -26_250, grossCents: -201_250, releasedAt: null }

function withCommission(lines: SourceDealerCommission[]): SourceLoan {
  return { ...base, assetFinance: { ...base.assetFinance!, dealerCommission: lines } }
}

const nonEmpty = (v: Vector) => Object.fromEntries(Object.entries(v).filter(([, c]) => c !== 0))
const vectorOf = (loan: SourceLoan, key: string, asOf: string) => nonEmpty(loanSources(loan, day(asOf)).find((s) => s.baseKey === key)?.vector ?? {})
const key = (kind: "dealer-commission" | "dealer-commission-paid", lineId: string) => `af:${base.id}:${kind}:${lineId}`

describe("dealer commission account roles", () => {
  it("are appended after AF_PRICE_CREDITS, so every earlier role keeps its place, and need the mapping confirmed again", () => {
    // the IFRS 9 roles were appended after them (accounts.ts IFRS9_ROLES)
    expect(ACCOUNT_ROLES.slice(-6, -3)).toEqual(["AF_PRICE_CREDITS", "DEALER_COMMISSION_EXPENSE", "DEALER_COMMISSION_PAYABLE"])
    expect(ASSET_FINANCE_ROLES.slice(-2)).toEqual(["DEALER_COMMISSION_EXPENSE", "DEALER_COMMISSION_PAYABLE"])
  })

  it("default to 6500 Dealer commission and 2600 Dealer commission payable; the expense nets into opening equity, the payable carries", () => {
    expect(DEFAULT_ACCOUNTS.DEALER_COMMISSION_EXPENSE).toMatchObject({ code: "6500", name: "Dealer commission" })
    expect(DEFAULT_ACCOUNTS.DEALER_COMMISSION_PAYABLE).toMatchObject({ code: "2600", name: "Dealer commission payable" })
    expect(NOT_CARRIED_AT_OPENING).toContain("DEALER_COMMISSION_EXPENSE")
    expect(NOT_CARRIED_AT_OPENING).not.toContain("DEALER_COMMISSION_PAYABLE")
  })
})

describe("dealer commission sources", () => {
  it("an EARNED line of a VAT-vendor dealer: Dr expense net, Dr input VAT, Cr payable gross, from its effective day", () => {
    const loan = withCommission([EARNED])
    expect(vectorOf(loan, key("dealer-commission", "dcl-1"), "2026-08-10")).toEqual({})
    expect(vectorOf(loan, key("dealer-commission", "dcl-1"), "2026-08-11")).toEqual({ DEALER_COMMISSION_EXPENSE: 175_000, INPUT_VAT: 26_250, DEALER_COMMISSION_PAYABLE: -201_250 })
  })

  it("a dealer that is not a VAT vendor posts no input VAT: the payable is the net", () => {
    const loan = withCommission([{ ...EARNED, vatCents: 0, grossCents: 175_000 }])
    expect(vectorOf(loan, key("dealer-commission", "dcl-1"), "2026-09-01")).toEqual({ DEALER_COMMISSION_EXPENSE: 175_000, DEALER_COMMISSION_PAYABLE: -175_000 })
  })

  it("a REVERSED line (clawback) is its own source with the exact negatives: expense, input VAT and payable all reverse", () => {
    const loan = withCommission([EARNED, REVERSED])
    expect(vectorOf(loan, key("dealer-commission", "dcl-2"), "2026-10-20")).toEqual({})
    expect(vectorOf(loan, key("dealer-commission", "dcl-2"), "2026-10-21")).toEqual({ DEALER_COMMISSION_EXPENSE: -175_000, INPUT_VAT: -26_250, DEALER_COMMISSION_PAYABLE: 201_250 })
    // The earned line is untouched by its reversal.
    expect(vectorOf(loan, key("dealer-commission", "dcl-1"), "2026-10-21")).toEqual({ DEALER_COMMISSION_EXPENSE: 175_000, INPUT_VAT: 26_250, DEALER_COMMISSION_PAYABLE: -201_250 })
  })

  it("a line in a released run is paid on the run's release: Dr payable, Cr bank, gross; unreleased, nothing", () => {
    const releasedAt = new Date("2026-09-05T11:00:00+02:00")
    expect(vectorOf(withCommission([EARNED]), key("dealer-commission-paid", "dcl-1"), "2026-12-01")).toEqual({})
    const paid = withCommission([{ ...EARNED, releasedAt }])
    expect(vectorOf(paid, key("dealer-commission-paid", "dcl-1"), "2026-09-05")).toEqual({})
    expect(vectorOf(paid, key("dealer-commission-paid", "dcl-1"), "2026-09-06")).toEqual({ DEALER_COMMISSION_PAYABLE: 201_250, BANK: -201_250 })
  })

  it("a clawback netted in a later run gives the money back through the run: Cr payable, Dr bank", () => {
    const loan = withCommission([EARNED, { ...REVERSED, releasedAt: new Date("2026-12-02T09:00:00+02:00") }])
    expect(vectorOf(loan, key("dealer-commission-paid", "dcl-2"), "2026-12-03")).toEqual({ DEALER_COMMISSION_PAYABLE: -201_250, BANK: 201_250 })
  })

  it("every source sums to zero, and earned, clawed back and both paid leaves nothing on the payable", () => {
    const loan = withCommission([{ ...EARNED, releasedAt: new Date("2026-09-05T11:00:00+02:00") }, { ...REVERSED, releasedAt: new Date("2026-12-02T09:00:00+02:00") }])
    const sources = loanSources(loan, day("2027-01-01"))
    for (const s of sources) expect(Object.values(s.vector).reduce((a, c) => a + (c ?? 0), 0), s.baseKey).toBe(0)
    const total = (role: keyof Vector) => sources.reduce((sum, s) => sum + (s.vector[role] ?? 0), 0)
    expect(total("DEALER_COMMISSION_PAYABLE")).toBe(0)
    expect(total("DEALER_COMMISSION_EXPENSE")).toBe(0)
  })

  it("a contract with no commission lines (staff deal, or slice-4 fixture without the field) has no commission source", () => {
    expect(loanSources(base, day("2027-01-01")).filter((s) => s.baseKey.includes(":dealer-commission"))).toEqual([])
  })
})

describe("dealer commission through the ledger delta", () => {
  const months = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"].map((k) => parsePeriodKey(k)!)
  const loan = withCommission([{ ...EARNED, releasedAt: new Date("2026-09-05T11:00:00+02:00") }, { ...REVERSED, releasedAt: new Date("2026-12-02T09:00:00+02:00") }])

  it("posts each event once in its own month, labelled DEALER_COMMISSION and DEALER_COMMISSION_PAID", () => {
    const state = ledger()
    const [aug, sep, oct, nov, dec] = months.map((m) => runWith(defaultAccounts(), null, [loan], m, state).filter((e) => e.baseKey.includes(":dealer-commission")))
    expect(aug.map((e) => [e.baseKey, e.eventType, e.postingDate])).toEqual([[key("dealer-commission", "dcl-1"), "DEALER_COMMISSION", "2026-08-10"]])
    expect(aug[0].description).toContain("AF-IS-0001")
    expect(sep.map((e) => [e.baseKey, e.eventType, e.postingDate])).toEqual([[key("dealer-commission-paid", "dcl-1"), "DEALER_COMMISSION_PAID", "2026-09-05"]])
    expect(oct.map((e) => [e.baseKey, e.eventType, e.postingDate])).toEqual([[key("dealer-commission", "dcl-2"), "DEALER_COMMISSION", "2026-10-20"]])
    expect(oct[0].lines.map((l) => [l.role, l.accountCode, l.debitCents, l.creditCents])).toEqual([
      ["DEALER_COMMISSION_PAYABLE", "2600", 201_250, 0], ["INPUT_VAT", "1300", 0, 26_250], ["DEALER_COMMISSION_EXPENSE", "6500", 0, 175_000],
    ])
    expect(nov).toEqual([])
    expect(dec.map((e) => [e.baseKey, e.eventType])).toEqual([[key("dealer-commission-paid", "dcl-2"), "DEALER_COMMISSION_PAID"]])
    expect(net(dec)).toEqual({ DEALER_COMMISSION_PAYABLE: -201_250, BANK: 201_250 })
  })

  it("a line earned before go-live: the opening entry carries the payable and the input VAT, the expense goes to opening equity", () => {
    const sep = months[1]
    const entry = openingEntry(openingPositions([withCommission([EARNED])], sep), sep, defaultAccounts())!
    const lines = Object.fromEntries(entry.lines.map((l) => [l.role, l.debitCents - l.creditCents]))
    expect(lines.DEALER_COMMISSION_PAYABLE).toBe(-201_250)
    expect(lines.DEALER_COMMISSION_EXPENSE).toBeUndefined()
  })
})

describe("IsaFlow: a month with commission needs both codes in the chart", () => {
  const chartOf = (codes: string[]): GlAccountRow[] => codes.map((code) => ({ id: `u-${code}`, account_code: code, account_name: code, account_type: "asset", account_subtype: null, is_active: true, parent_account_id: null }))

  it("nets the expense and the payable onto 6500 and 2600, and the chart check names them when IsaFlow lacks them", () => {
    const entries = runWith(defaultAccounts(), null, [withCommission([EARNED])], AUGUST, ledger()).filter((e) => e.baseKey.includes(":dealer-commission"))
    const lines = entries.flatMap((e) => e.lines.map((l, i) => ({ lineNo: i, postingDate: e.postingDate, accountCode: l.accountCode, taxCode: l.taxCode, debitCents: l.debitCents, creditCents: l.creditCents, reference: e.reference, description: e.description, eventKey: e.eventKey, role: l.role })))
    const draft = netByAccount(lines)
    expect(draft).toEqual([
      { code: "1300", debitCents: 26_250, creditCents: 0 }, { code: "2600", debitCents: 0, creditCents: 201_250 }, { code: "6500", debitCents: 175_000, creditCents: 0 },
    ])
    expect(resolveChart(draft.map((l) => l.code), chartOf(["1300"]))).toEqual({ ok: false, missing: ["2600", "6500"], inactive: [], ambiguous: [] })
    expect(resolveChart(draft.map((l) => l.code), chartOf(["1300", "2600", "6500"]))).toMatchObject({ ok: true })
  })
})
