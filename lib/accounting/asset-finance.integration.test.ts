/**
 * Real-Postgres proof of the asset-finance journals (slice 4b): a lender
 * holding an instalment sale, a finance lease, two full-maintenance leases and
 * two repossessions closes three months, each month balanced, every receivable
 * tied to the independent SQL and every asset-finance control at nil. The same
 * deals as lib/asset-finance/__fixtures__/acceptance-journal-*.ts, whose
 * figures were worked by hand: the ledger must hold exactly those vectors.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/asset-finance.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { day, INSTALMENT_JOURNAL_DEALS, type JournalDeal } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { LEASE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-lease-deals"
import { RECOVERY_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-recovery-deals"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { ASSET_FINANCE_ROLES } from "./accounts"
import { insertSourceLoan, removeSourceLoans } from "./asset-finance.integration-fixture"
import { renderCsv } from "./csv"
import { AccountingPeriodError, closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"
import { independentBook } from "./reconcile"
import { loanSources, type SourceLoan, type Vector } from "./sources"
import type { SourceRecovery } from "./source-types"
import { loadBatchLines, loadLedger } from "./store"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const AFTER = new Date("2026-11-05T10:00:00+02:00")
const NOVEMBER = day("2026-11-01")
let tenant: ChargesTenant

const [IS_1, FL_1] = INSTALMENT_JOURNAL_DEALS
const [LS, LR] = LEASE_JOURNAL_DEALS
const [SHORT, SURPLUS] = RECOVERY_JOURNAL_DEALS

/** An instalment sale of IS-1's shape that is then repossessed: the recovery of a fixture, re-identified. */
function repossessed(base: JournalDeal, recoveryDeal: JournalDeal, s: string): SourceLoan {
  const id = (x: string) => `${x}-${s}`
  const rec: SourceRecovery = structuredClone(recoveryDeal.loan.assetFinance!.recoveries[0])
  const sale = rec.sale && { ...rec.sale, id: id(rec.sale.id), invoice: { ...rec.sale.invoice, id: id(rec.sale.invoice.id) } }
  const recovery: SourceRecovery = {
    ...rec, id: id(rec.id), proceedsPaymentId: rec.proceedsPaymentId && id(rec.proceedsPaymentId), sale,
    costs: rec.costs.map((c) => ({ ...c, id: id(c.id) })), vatEvents: rec.vatEvents.map((e) => ({ ...e, id: id(e.id) })),
    refund: rec.refund && { ...rec.refund, id: id(rec.refund.id) },
  }
  const af = base.loan.assetFinance!
  return {
    ...base.loan, id: id(base.loan.id), reference: `${base.loan.reference}-${s}`, payments: recoveryDeal.loan.payments.map((p) => ({ ...p, id: id(p.id) })),
    charges: recoveryDeal.loan.charges.map((c) => ({ ...c, sourceId: c.sourceId && id(c.sourceId) })),
    schedule: base.loan.schedule.map((r) => ({ ...r, id: id(r.id) })),
    assetFinance: { ...af, inceptionInvoice: af.inceptionInvoice && { ...af.inceptionInvoice, id: id(af.inceptionInvoice.id) }, recoveries: [recovery] },
  }
}

const loans = (): SourceLoan[] => [IS_1.loan, FL_1.loan, LS.loan, LR.loan, repossessed(IS_1, SHORT, "a"), repossessed(IS_1, SURPLUS, "b")]

const close = (periodKey: string) => runWithTenant(tenant.tenantId, () =>
  closePeriod(prisma, { tenantId: tenant.tenantId, periodKey, userId: tenant.userId, userEmail: "af-it@test.invalid", now: AFTER }))
const plan = (periodKey: string) => runWithTenant(tenant.tenantId, () => planPeriod(prisma, tenant.tenantId, parsePeriodKey(periodKey)!, AFTER))
const replica = (...ops: Array<ReturnType<typeof db.$executeRawUnsafe>>) => db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"), ...ops])
const nonEmpty = (v: Vector) => Object.fromEntries(Object.entries(v).filter(([, cents]) => cents !== 0))

suite.sequential("asset-finance journals (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await removeSourceLoans(db, loans().map((l) => l.id))
    for (const loan of loans()) await insertSourceLoan(db, tenant, loan)
    await db.accountingSettings.create({ data: { tenantId: tenant.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08" } })
  })
  // The rows go: a tax invoice dated tomorrow or later would block another suite's new VAT rate (lib/vat/vat-rate.integration.test.ts).
  afterAll(async () => { await removeSourceLoans(db, loans().map((l) => l.id)); await db.$disconnect() })

  it("refuses a month that posts asset-finance accounts the confirmed mapping did not cover, until it is confirmed again", async () => {
    expect((await plan("2026-08")).refusal).toMatchObject({ code: "MAPPING_NOT_CONFIRMED", message: expect.stringContaining("AF_INSTALMENT_DEBTORS") })
    await expect(close("2026-08")).rejects.toMatchObject({ code: "MAPPING_NOT_CONFIRMED" })
    await db.accountingSettings.update({ where: { tenantId: tenant.tenantId }, data: { mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
    expect((await plan("2026-08")).refusal).toBeNull()
  })

  it("refuses a month whose instalment-sale receivable does not tie to the schedule (the financed amount is not the first opening balance)", async () => {
    await replica(db.$executeRawUnsafe(`UPDATE "RepaymentSchedule" SET "assetFinanceOpeningBalanceCents" = "assetFinanceOpeningBalanceCents" + 1 WHERE "id" = 'is1-r1'`))
    try {
      await expect(close("2026-08")).rejects.toMatchObject({ code: "RECONCILIATION_FAILED" })
    } finally {
      await replica(db.$executeRawUnsafe(`UPDATE "RepaymentSchedule" SET "assetFinanceOpeningBalanceCents" = "assetFinanceOpeningBalanceCents" - 1 WHERE "id" = 'is1-r1'`))
    }
    expect((await plan("2026-08")).refusal).toBeNull()
  })

  it("refuses a month with an asset-finance control that differs: an invoice whose VAT is not the rental's, a proceeds payment that is not the recovery's", async () => {
    await replica(db.$executeRawUnsafe(`UPDATE "TaxInvoice" SET "vatCents" = "vatCents" + 1, "totalInclVatCents" = "totalInclVatCents" + 1 WHERE "id" = 'inv-lr-1'`))
    try {
      const skewed = await plan("2026-08")
      expect(skewed.controls).toEqual([{ control: "AF_OUTPUT_VAT", key: "jrn-lr", journalCents: -18_000, bookCents: -18_001 }])
      expect(skewed.refusal).toMatchObject({ code: "AF_CONTROL_FAILED" })
    } finally {
      await replica(db.$executeRawUnsafe(`UPDATE "TaxInvoice" SET "vatCents" = "vatCents" - 1, "totalInclVatCents" = "totalInclVatCents" - 1 WHERE "id" = 'inv-lr-1'`))
    }
    await replica(db.$executeRawUnsafe(`UPDATE "Payment" SET "amount" = "amount" + 1 WHERE "id" = 'pay-surplus-b'`))
    try {
      expect((await plan("2026-10")).controls).toContainEqual({ control: "RECOVERY_RESULT", key: "r-surplus-b", journalCents: 43_501, bookCents: 43_500 })
    } finally {
      await replica(db.$executeRawUnsafe(`UPDATE "Payment" SET "amount" = "amount" - 1 WHERE "id" = 'pay-surplus-b'`))
    }
    expect((await plan("2026-08")).refusal).toBeNull()
    expect((await plan("2026-10")).controls).toEqual([])
  })

  it("refuses, rather than posts wrongly, a credit note against an instalment sale's inception invoice", async () => {
    await replica(db.$executeRawUnsafe(`INSERT INTO "CreditNote" ("id", "tenantId", "number", "creditNoteNumber", "issueDate", "invoiceId", "reason", "exclVatCents", "vatCents", "inclVatCents")
      VALUES ('cn-is-it', '${tenant.tenantId}', 9001, 'CN-9001', '2026-08-20', 'inv-is1', 'synthetic', 1000, 150, 1150)`))
    try {
      expect((await plan("2026-08")).refusal).toMatchObject({ code: "AF_SOURCE_UNSUPPORTED", message: expect.stringContaining("AF-IS-0001") })
    } finally {
      await replica(db.$executeRawUnsafe(`DELETE FROM "CreditNote" WHERE "id" = 'cn-is-it'`))
    }
  })

  it("refuses a lease it cannot post yet (a deposit or trade-in) instead of posting it wrongly", async () => {
    await replica(db.$executeRawUnsafe(`UPDATE "Payout" SET "amountCents" = "amountCents" - 100 WHERE "id" = 'payout-jrn-ls'`))
    try {
      expect((await plan("2026-08")).refusal).toMatchObject({ code: "AF_SOURCE_UNSUPPORTED", message: expect.stringContaining("AF-LS-0001") })
    } finally {
      await replica(db.$executeRawUnsafe(`UPDATE "Payout" SET "amountCents" = "amountCents" + 100 WHERE "id" = 'payout-jrn-ls'`))
    }
  })

  it("closes August (go-live), September and October, each balanced and tied", async () => {
    for (const key of ["2026-08", "2026-09", "2026-10"]) {
      const out = await close(key)
      expect(out.created).toBe(true)
      const batch = await db.accountingExportBatch.findUniqueOrThrow({ where: { id: out.batchId } })
      expect(batch.status).toBe("CLOSED")
      expect(batch.totalDebitCents).toBe(batch.totalCreditCents)
      expect((await plan(key)).controls).toEqual([])
    }
    await expect(close("2026-08")).resolves.toMatchObject({ created: false })
    await expect(runWithTenant(tenant.tenantId, () => closePeriod(prisma, { tenantId: tenant.tenantId, periodKey: "2026-11", userId: tenant.userId, userEmail: "x@test.invalid", now: AFTER })))
      .rejects.toBeInstanceOf(AccountingPeriodError)
  })

  it("holds exactly the hand-worked vector of every lease and recovery source, and the schedule-derived ones of the instalment sales", async () => {
    const { posted } = await runWithTenant(tenant.tenantId, () => loadLedger(prisma, tenant.tenantId))
    const heldOf = (keys: string[]) => Object.fromEntries(keys.filter((k) => Object.keys(nonEmpty(posted.get(k) ?? {})).length > 0).map((k) => [k, nonEmpty(posted.get(k) ?? {})]))
    const expected = (deal: JournalDeal) => Object.fromEntries(Object.entries(deal.expected).map(([k, v]) => [k, nonEmpty(v)]).filter(([, v]) => Object.keys(v as Vector).length > 0))
    for (const deal of [LS, LR]) expect(heldOf(Object.keys(deal.expected))).toEqual(expected(deal))
    // The recoveries ride on instalment sales here: only their own sources are the worked ones.
    for (const [deal, s] of [[SHORT, "a"], [SURPLUS, "b"]] as const) {
      const keys = Object.keys(deal.expected).map((k) => k.replace(/(r-(short|surplus)|cost-\d|vat-1|sale-1|inv-sale|pay-(short|surplus)|refund-1)/g, (m) => `${m}-${s}`).replace(`loan:${deal.loan.id}-${s}`, `loan:${IS_1.loan.id}-${s}`).replace(`loan:${deal.loan.id}`, `loan:${IS_1.loan.id}-${s}`))
      const held = heldOf(keys)
      const want = Object.fromEntries(Object.entries(expected(deal)).map(([k, v]) => [keys[Object.keys(deal.expected).indexOf(k)], v]))
      expect(held).toEqual(want)
    }
    const instalments = (deal: JournalDeal) => Object.fromEntries(loanSources(deal.loan, NOVEMBER).filter((s) => Object.keys(nonEmpty(s.vector)).length > 0).map((s) => [s.baseKey, nonEmpty(s.vector)]))
    for (const deal of [IS_1, FL_1]) expect(heldOf(Object.keys(instalments(deal)))).toEqual(instalments(deal))
  })

  it("owes what the schedules, invoices and receipts say, to the cent, per the independent SQL", async () => {
    const book = await runWithTenant(tenant.tenantId, () => independentBook(prisma, tenant.tenantId, NOVEMBER))
    // IS-1: 1 000 000 + 10 000 + 10 100 + 6 201 - 400 000; FL-1: 2 000 000 + 20 000 + 13 200 + 6 332 (row 3 fell due 10-31)
    expect(book.get("jrn-is-1")?.cents).toBe(626_301)
    expect(book.get("jrn-fl-1")?.cents).toBe(2_039_532)
    expect(book.get("jrn-ls")?.cents).toBe(428_835) // 3 rentals + the end-of-term invoice - credit notes 13 800 and 115
    expect(book.get("jrn-lr")?.cents).toBe(908_500) // 2 rentals + the purchase invoice - the receipt - the credit note 11 500
  })

  it("exports the asset-finance lines in the generic and Sage CSV, with no tax code on them", async () => {
    const batch = await db.accountingExportBatch.findFirstOrThrow({ where: { tenantId: tenant.tenantId, periodKey: "2026-09" } })
    const lines = (await runWithTenant(tenant.tenantId, () => loadBatchLines(prisma, tenant.tenantId, batch.id)))!
    const generic = renderCsv("generic", lines)
    const sage = renderCsv("sage", lines).split("\r\n")
    expect(lines.some((l) => l.role === "LEASE_DEBTORS") && lines.some((l) => l.role === "RENTAL_INCOME")).toBe(true)
    expect(generic).toContain('"1120"')
    expect(generic).toContain('"4100"')
    for (const row of sage.filter((r) => r.includes('"1120"') || r.includes('"4100"'))) expect(row.split(",")[4]).toBe('""')
  })
})
