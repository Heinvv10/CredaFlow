import { afterAll, describe, expect, it } from "vitest"
import { day, INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { LEASE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-lease-deals"
import { RECOVERY_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-recovery-deals"
import { closeMonths, db, dropLender, expectedBank, ledgerTotals, newLender, RUN, renamed, repossessedLoan, type Lender } from "./af-break.fixture"
import type { SourceLoan, SourcePayment } from "./source-types"

const suite = RUN ? describe : describe.skip
const MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11"]
const lenders: Lender[] = []
const problems: string[] = []
const expectedStuck: string[] = []
const EXPECTED_STUCK = ["LS never funded (payout null), cancelled", "LS booked, payout pending, active"]
afterAll(async () => { for (const l of lenders) await dropLender(l); await db?.$disconnect() })
const [IS_1] = INSTALMENT_JOURNAL_DEALS
const [LS, LR] = LEASE_JOURNAL_DEALS
const [SHORT, SURPLUS, SURPLUS_CHARGED, WITHDRAWN] = RECOVERY_JOURNAL_DEALS
let n = 0
const s = () => `x${++n}`

const pay = (id: string, amount: number, at: string, over: Partial<SourcePayment> = {}): SourcePayment => ({
  id, amount, paymentMethod: "EFT", receivedAt: new Date(at), allocationStatus: "ALLOCATED", reconciledAt: null, reversed: false, reversedAt: null,
  parentPaymentId: null, defaultInterestAllocated: 0, chargeFeesAllocated: 0, ...over,
})

async function run(label: string, loan: SourceLoan) {
  const lender = await newLender([loan])
  lenders.push(lender)
  const out = await closeMonths(lender.tenant, MONTHS)
  const bad = out.find((o) => !o.closed)
  const bank = (await ledgerTotals(lender.tenant.tenantId)).BANK ?? 0
  const oracle = await expectedBank(lender.tenant.tenantId, new Date("2026-12-01T00:00:00+02:00"))
  if (bad && !EXPECTED_STUCK.includes(label)) problems.push(`${label}: stuck at ${bad.key} ${bad.code} ${bad.message?.slice(0, 160)}`)
  if (!bad && bank !== oracle) problems.push(`${label}: BANK ledger ${bank} vs tables ${oracle}`)
  if (bad && EXPECTED_STUCK.includes(label)) expectedStuck.push(`${label}: ${bad.code}`)
}

suite.sequential("matrix2", () => {
  it("runs", async () => {
    const is = () => renamed(IS_1.loan, s())
    const ls = () => renamed(LS.loan, s())
    const lr = () => renamed(LR.loan, s())
    const withPay = (l: SourceLoan, p: SourcePayment[]): SourceLoan => ({ ...l, payments: [...l.payments, ...p.map((x) => ({ ...x, id: `${x.id}-${l.id}` }))] })
    const kinds: Array<[string, () => SourceLoan]> = [["IS", is], ["LS", ls], ["LR", lr]]
    for (const [k, mk] of kinds) {
      await run(`${k} receipt before inception`, withPay(mk(), [pay("pb", 1000, "2026-07-01T10:00:00+02:00")]))
      await run(`${k} receipt reversed later`, withPay(mk(), [pay("pr", 5000, "2026-08-20T10:00:00+02:00", { reversed: true, reversedAt: new Date("2026-10-02T10:00:00+02:00") })]))
      await run(`${k} receipt reversed same month`, withPay(mk(), [pay("pr2", 5000, "2026-08-20T10:00:00+02:00", { reversed: true, reversedAt: new Date("2026-08-25T10:00:00+02:00") })]))
      await run(`${k} unapplied receipt`, withPay(mk(), [pay("pu", 5000, "2026-08-20T10:00:00+02:00", { allocationStatus: "UNAPPLIED" })]))
      await run(`${k} unapplied then applied`, withPay(mk(), [pay("pu2", 5000, "2026-08-20T10:00:00+02:00", { allocationStatus: "ALLOCATED", reconciledAt: new Date("2026-10-10T10:00:00+02:00") })]))
      await run(`${k} refunded receipt`, withPay(mk(), [pay("pf", 5000, "2026-08-20T10:00:00+02:00", { allocationStatus: "REFUNDED", reconciledAt: new Date("2026-09-10T10:00:00+02:00") })]))
      await run(`${k} waiver`, withPay(mk(), [pay("pw", 100, "2026-09-20T10:00:00+02:00", { paymentMethod: "WAIVER" })]))
      await run(`${k} receipt exactly at month end`, withPay(mk(), [pay("pm", 5000, "2026-08-31T22:00:00Z")]))
      await run(`${k} receipt at last ms`, withPay(mk(), [pay("pm2", 5000, "2026-08-31T21:59:59.999Z")]))
      await run(`${k} overpaid (split half)`, withPay(mk(), [pay("pp", 700000, "2026-09-02T10:00:00+02:00"), pay("pq", 100000, "2026-09-02T10:00:00+02:00", { parentPaymentId: "pp-PLACEHOLDER", allocationStatus: "UNAPPLIED" })]))
      await run(`${k} default charges`, { ...mk(), charges: [{ type: "DEFAULT_INTEREST", day: day("2026-09-20"), amount: 777, sourceId: null }, { type: "SERVICE_FEE", day: day("2026-10-20"), amount: 69, sourceId: null }] })
      await run(`${k} default charge after write-off`, { ...mk(), status: "WRITTEN_OFF", writeOffAt: day("2026-09-10"), charges: [{ type: "DEFAULT_INTEREST", day: day("2026-09-20"), amount: 777, sourceId: null }] })
      await run(`${k} receipt after write-off`, withPay({ ...mk(), status: "WRITTEN_OFF", writeOffAt: day("2026-09-10") }, [pay("paw", 5000, "2026-10-20T10:00:00+02:00")]))
      await run(`${k} receipt on write-off day`, withPay({ ...mk(), status: "WRITTEN_OFF", writeOffAt: new Date("2026-09-20T10:00:00+02:00") }, [pay("pwd", 5000, "2026-09-20T10:00:00+02:00")]))
    }
    // credit notes
    const lsCredit = (issue: string, excl: number, vat: number, invId: string) => (l: SourceLoan): SourceLoan => ({
      ...l, assetFinance: { ...l.assetFinance!, creditNotes: [...l.assetFinance!.creditNotes, { id: `cn-x-${l.id}`, invoiceId: `${invId}-${l.id.split("jrn-ls-")[1] ?? ""}`, issueDate: day(issue), exclVatCents: excl, vatCents: vat, inclVatCents: excl + vat, invoiceIncome: [{ role: "RENTAL_INCOME", exclVatCents: 100_000 }, { role: "MAINTENANCE_INCOME", exclVatCents: 20_000 }] }] },
    })
    const wo = (at: string) => (l: SourceLoan): SourceLoan => ({ ...l, status: "WRITTEN_OFF", writeOffAt: day(at) })
    const l1 = ls(); await run("LS credit note after write-off", lsCredit("2026-10-20", 5000, 750, "inv-ls-1")(wo("2026-09-10")(l1)))
    const l2 = ls(); await run("LS credit note larger than rental (cap?)", lsCredit("2026-10-20", 500000, 75000, "inv-ls-1")(l2))
    const l3 = ls(); await run("LS credit note on cancelled lease", lsCredit("2026-10-20", 5000, 750, "inv-ls-1")({ ...l3, status: "CANCELLED", closedAt: day("2026-09-20") }))
    const l4 = ls(); await run("LS credit note before the invoice's supply", lsCredit("2026-07-20", 5000, 750, "inv-ls-1")(l4))
    // recoveries
    const rep = (d: typeof SHORT, over: Partial<SourceLoan> = {}) => ({ ...repossessedLoan(IS_1.loan, d.loan, s()), ...over })
    await run("rec SHORT", rep(SHORT))
    await run("rec SURPLUS", rep(SURPLUS))
    await run("rec SURPLUS_CHARGED", rep(SURPLUS_CHARGED))
    await run("rec WITHDRAWN", rep(WITHDRAWN))
    await run("rec SHORT then written off after proceeds", rep(SHORT, { status: "WRITTEN_OFF", writeOffAt: day("2026-10-25") }))
    await run("rec SHORT written off before proceeds", rep(SHORT, { status: "WRITTEN_OFF", writeOffAt: day("2026-10-01") }))
    await run("rec WITHDRAWN + loan completed", rep(WITHDRAWN, { status: "COMPLETED", closedAt: day("2026-10-04") }))
    await run("rec SURPLUS loan cancelled after", rep(SURPLUS, { status: "CANCELLED", closedAt: day("2026-10-25") }))
    // unfunded
    const unfunded = ls(); unfunded.assetFinance = { ...unfunded.assetFinance!, payout: null, rentals: [], sundryInvoices: [], creditNotes: [], fund: null }
    await run("LS never funded (payout null), cancelled", { ...unfunded, status: "CANCELLED", closedAt: day("2026-08-10"), payments: [] })
    await run("LS booked, payout pending, active", { ...unfunded, payments: [] })
    expect(problems, problems.join("\n")).toEqual([])
    // documented refusal (the supplier was never paid: nothing to post, and the sources refuse rather than guess)
    expect(expectedStuck).toEqual(["LS never funded (payout null), cancelled: AF_SOURCE_UNSUPPORTED", "LS booked, payout pending, active: AF_SOURCE_UNSUPPORTED"])
  }, 1_800_000)
})
