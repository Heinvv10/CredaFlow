import { afterAll, describe, expect, it } from "vitest"
import { day, INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { LEASE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-lease-deals"
import { RECOVERY_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-recovery-deals"
import { closeMonths, db, dropLender, expectedBank, ledgerTotals, newLender, repossessedLoan, RUN, renamed, type Lender } from "./af-break.fixture"
import type { SourceLoan } from "./source-types"

const suite = RUN ? describe : describe.skip
const MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11"]
const lenders: Lender[] = []
afterAll(async () => { for (const l of lenders) await dropLender(l); await db?.$disconnect() })

const [IS_1, FL_1] = INSTALMENT_JOURNAL_DEALS
const [LS, LR] = LEASE_JOURNAL_DEALS
const [SHORT, SURPLUS, SURPLUS_CHARGED, WITHDRAWN] = RECOVERY_JOURNAL_DEALS

const problems: string[] = []
async function run(label: string, loan: SourceLoan) {
  const lender = await newLender([loan])
  lenders.push(lender)
  const out = await closeMonths(lender.tenant, MONTHS)
  const bank = (await ledgerTotals(lender.tenant.tenantId)).BANK ?? 0
  const oracle = await expectedBank(lender.tenant.tenantId, new Date("2026-12-01T00:00:00+02:00"))
  const bad = out.find((o) => !o.closed)
  if (bad) problems.push(`${label}: stuck at ${bad.key} ${bad.code} ${bad.message?.slice(0, 160)}`)
  if (bank !== oracle) problems.push(`${label}: BANK ledger ${bank} vs tables ${oracle}`)
  return { lender, out }
}

suite.sequential("matrix", () => {
  it("runs", async () => {
    let n = 0
    const v = (l: SourceLoan, over: Partial<SourceLoan>) => ({ ...l, ...over })
    const s = () => `m${++n}`
    await run("IS base", renamed(IS_1.loan, s()))
    await run("FL base", renamed(FL_1.loan, s()))
    await run("LS base", renamed(LS.loan, s()))
    await run("LR base", renamed(LR.loan, s()))
    const rep = (d: typeof SHORT) => repossessedLoan(IS_1.loan, d.loan, s())
    await run("SHORT base", rep(SHORT))
    await run("SURPLUS base", rep(SURPLUS))
    await run("SURPLUS_CHARGED base", rep(SURPLUS_CHARGED))
    await run("WITHDRAWN base", rep(WITHDRAWN))
    for (const at of ["2026-07-20", "2026-08-15", "2026-09-10", "2026-09-15", "2026-10-20", "2026-12-01"]) {
      await run(`IS written off ${at}`, v(renamed(IS_1.loan, s()), { status: "WRITTEN_OFF", writeOffAt: day(at) }))
      await run(`IS cancelled ${at}`, v(renamed(IS_1.loan, s()), { status: "CANCELLED", closedAt: day(at) }))
      await run(`IS completed ${at}`, v(renamed(IS_1.loan, s()), { status: "COMPLETED", closedAt: day(at) }))
      await run(`LS written off ${at}`, v(renamed(LS.loan, s()), { status: "WRITTEN_OFF", writeOffAt: day(at) }))
      await run(`LS cancelled ${at}`, v(renamed(LS.loan, s()), { status: "CANCELLED", closedAt: day(at) }))
      await run(`LR written off ${at}`, v(renamed(LR.loan, s()), { status: "WRITTEN_OFF", writeOffAt: day(at) }))
      await run(`SHORT written off ${at}`, v(rep(SHORT), { status: "WRITTEN_OFF", writeOffAt: day(at) }))
      await run(`SURPLUS completed ${at}`, v(rep(SURPLUS), { status: "COMPLETED", closedAt: day(at) }))
      await run(`SURPLUS_CHARGED completed ${at}`, v(rep(SURPLUS_CHARGED), { status: "COMPLETED", closedAt: day(at) }))
      await run(`WITHDRAWN cancelled ${at}`, v(rep(WITHDRAWN), { status: "CANCELLED", closedAt: day(at) }))
    }
    expect(problems, problems.join("\n")).toEqual([])
  }, 900_000)
})
