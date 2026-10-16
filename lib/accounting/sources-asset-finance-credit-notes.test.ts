import { describe, expect, it } from "vitest"
import { day } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { CREDIT_NOTE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-credit-note-deals"
import { defaultAccounts, ledger, runWith } from "./derive.test-helpers"
import { parsePeriodKey } from "./period"
import { loanSources, type SourceLoan, type Vector } from "./sources"

const [IS_CN, IS_CN_EARLY, REC_SALE_CN] = CREDIT_NOTE_JOURNAL_DEALS
const nonEmpty = (v: Vector) => Object.fromEntries(Object.entries(v).filter(([, cents]) => cents !== 0))
const sourceOf = (loan: SourceLoan, asOf: string, key: string) => loanSources(loan, day(asOf)).find((s) => s.baseKey === key)!

describe("a credit note on an instalment sale's inception invoice", () => {
  it("posts nothing before it is issued", () => {
    expect(nonEmpty(sourceOf(IS_CN.loan, "2026-08-20", "af-credit:cn-is-1").vector)).toEqual({})
    expect(nonEmpty(sourceOf(IS_CN.loan, "2026-08-21", "af-credit:cn-is-1").vector)).toEqual(IS_CN.expected["af-credit:cn-is-1"])
  })

  it("dated before the payout's release, posts with the inception and is dated by the release", () => {
    expect(nonEmpty(sourceOf(IS_CN_EARLY.loan, "2026-08-01", "af-credit:cn-is-early").vector)).toEqual({})
    const august = sourceOf(IS_CN_EARLY.loan, "2026-09-01", "af-credit:cn-is-early")
    expect(nonEmpty(august.vector)).toEqual({ AF_PRICE_CREDITS: 10_000, OUTPUT_VAT: 1_500, AF_INSTALMENT_DEBTORS: -11_500 })
    expect(august.origin).toMatchObject({ type: "CREDIT_NOTE", date: new Date("2026-08-03T09:00:00+02:00") })
  })

  // A credit note after a write-off, and one on a finance lease: JRN-IS-CN-WO and JRN-FL-CN in sources-asset-finance.test.ts.
  it("posts nothing when no payout was released (the loader refuses that contract)", () => {
    const loan = { ...IS_CN.loan, assetFinance: { ...IS_CN.loan.assetFinance!, payout: null } }
    expect(nonEmpty(sourceOf(loan, "2026-12-01", "af-credit:cn-is-1").vector)).toEqual({})
  })
})

describe("a credit note on a repossession sale's buyer invoice", () => {
  it("issued after the proceeds were applied, posts in its own month and moves the result with it, leaving clearing at nil", () => {
    const rec = REC_SALE_CN.loan.assetFinance!.recoveries[0]
    const late = { id: "cn-sale-late", issueDate: day("2026-11-10"), exclVatCents: 20_000, vatCents: 3_000, inclVatCents: 23_000 }
    const loan: SourceLoan = { ...REC_SALE_CN.loan, assetFinance: { ...REC_SALE_CN.loan.assetFinance!, recoveries: [{ ...rec, sale: { ...rec.sale!, creditNotes: [...rec.sale!.creditNotes!, late] } }] } }
    const state = ledger()
    runWith(defaultAccounts(), null, [loan], parsePeriodKey("2026-10")!, state)
    const november = runWith(defaultAccounts(), null, [loan], parsePeriodKey("2026-11")!, state)
    const lines = (key: string) => Object.fromEntries(november.filter((e) => e.baseKey === key).flatMap((e) => e.lines.map((l) => [l.role, l.debitCents - l.creditCents])))
    expect(lines("af-recovery:r-cn:sale-credit:cn-sale-late")).toEqual({ OUTPUT_VAT: 3_000, RECOVERY_CLEARING: 20_000, BANK: -23_000 })
    expect(lines("af-recovery:r-cn:result")).toEqual({ RECOVERY_CLEARING: -20_000, RECOVERY_RESULT: 20_000 })
    const clearing = loanSources(loan, day("2026-12-01")).reduce((t, s) => t + (s.vector.RECOVERY_CLEARING ?? 0), 0)
    expect(clearing).toBe(0)
  })
})
