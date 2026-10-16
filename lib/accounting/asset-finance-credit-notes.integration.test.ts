/**
 * Real-Postgres proof of the credit-note sources (slice 4b, F3): a credit note
 * on an instalment sale's inception invoice (one dated before its payout was
 * released, one after a write-off, one on a finance lease) and one on a
 * repossession sale's buyer invoice post, and every
 * month from July to November closes balanced, tied to the independent SQL and
 * with every asset-finance control at nil. The deals are
 * lib/asset-finance/__fixtures__/acceptance-journal-credit-note-deals.ts, worked
 * by hand: the ledger must hold exactly those vectors. November adds a credit
 * note on each invoice through the real issuer, the sale's after its proceeds
 * were applied.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/asset-finance-credit-notes.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { day, type JournalDeal } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { CREDIT_NOTE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-credit-note-deals"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { issueCreditNote } from "@/lib/vat/credit-note"
import { ASSET_FINANCE_ROLES } from "./accounts"
import { insertSourceLoan, removeSourceLoans } from "./asset-finance.integration-fixture"
import { closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"
import { independentBook } from "./reconcile"
import type { Vector } from "./source-types"
import { loadLedger } from "./store"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const AFTER = new Date("2026-12-05T10:00:00+02:00")
let tenant: ChargesTenant

const [IS_CN, IS_CN_EARLY, REC_SALE_CN, FL_CN, IS_CN_WO] = CREDIT_NOTE_JOURNAL_DEALS
const loanIds = CREDIT_NOTE_JOURNAL_DEALS.map((d) => d.loan.id)

const close = (periodKey: string) => runWithTenant(tenant.tenantId, () =>
  closePeriod(prisma, { tenantId: tenant.tenantId, periodKey, userId: tenant.userId, userEmail: "af-cn-it@test.invalid", now: AFTER }))
const plan = (periodKey: string) => runWithTenant(tenant.tenantId, () => planPeriod(prisma, tenant.tenantId, parsePeriodKey(periodKey)!, AFTER))
const nonEmpty = (v: Vector) => Object.fromEntries(Object.entries(v).filter(([, cents]) => cents !== 0))
const credit = (invoiceId: string, issueDate: string, exclVatCents: number) =>
  prisma.$transaction((tx) => issueCreditNote(tx as never, { tenantId: tenant.tenantId, invoiceId, issueDate, reason: "Synthetic credit", exclVatCents, createdById: tenant.userId }))

async function closeTied(key: string) {
  const out = await close(key)
  expect(out.created, key).toBe(true)
  const batch = await db.accountingExportBatch.findUniqueOrThrow({ where: { id: out.batchId } })
  expect(batch.totalDebitCents, key).toBe(batch.totalCreditCents)
  const after = await plan(key)
  expect(after.controls, key).toEqual([])
  expect(after.reconciliation.mismatches, key).toEqual([])
}

/** The ledger holds exactly the deal's hand-worked vectors, and the independent SQL owes its worked receivable, as at its date. */
async function expectWorked(deal: JournalDeal) {
  const { posted } = await runWithTenant(tenant.tenantId, () => loadLedger(prisma, tenant.tenantId))
  const expected = Object.fromEntries(Object.entries(deal.expected).map(([k, v]) => [k, nonEmpty(v)]).filter(([, v]) => Object.keys(v).length > 0))
  const held = Object.fromEntries(Object.keys(deal.expected).map((k) => [k, nonEmpty(posted.get(k) ?? {})]).filter(([, v]) => Object.keys(v).length > 0))
  expect(held, deal.id).toEqual(expected)
  const book = await runWithTenant(tenant.tenantId, () => independentBook(prisma, tenant.tenantId, day(deal.asOf)))
  expect(book.get(deal.loan.id)?.cents, deal.id).toBe(deal.receivableCents)
}

suite.sequential("asset-finance credit notes (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await removeSourceLoans(db, loanIds)
    for (const deal of CREDIT_NOTE_JOURNAL_DEALS) await insertSourceLoan(db, tenant, deal.loan)
    // Confirmed before the price-credit account existed: every other asset-finance role is covered.
    await db.accountingSettings.create({ data: {
      tenantId: tenant.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-07", mappingConfirmedRoles: ASSET_FINANCE_ROLES.filter((r) => r !== "AF_PRICE_CREDITS"),
    } })
  })
  // The rows go: a tax document dated after today would be left behind for the other suites.
  afterAll(async () => { await removeSourceLoans(db, loanIds); await db.$disconnect() })

  it("still refuses a credit note on an instalment sale's tax invoice other than its inception invoice", async () => {
    const replica = (...ops: Array<ReturnType<typeof db.$executeRawUnsafe>>) => db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"), ...ops])
    await replica(
      db.$executeRawUnsafe(`INSERT INTO "TaxInvoice" ("id", "tenantId", "number", "invoiceNumber", "issueDate", "supplyDate", "loanId", "supplierName", "supplierAddress", "supplierVatNumber",
        "recipientName", "recipientAddress", "vatRate", "totalExclVatCents", "vatCents", "totalInclVatCents")
        VALUES ('inv-cn-other', '${tenant.tenantId}', 9001, 'INV-9001', '2026-07-20', '2026-07-20', '${IS_CN.loan.id}', 'TEST Lender', '1 Test Street', '4000000001', 'TEST Debtor', '2 Test Road', 0.15, 1000, 150, 1150)`),
      db.$executeRawUnsafe(`INSERT INTO "CreditNote" ("id", "tenantId", "number", "creditNoteNumber", "issueDate", "invoiceId", "reason", "exclVatCents", "vatCents", "inclVatCents")
        VALUES ('cn-other', '${tenant.tenantId}', 9001, 'CN-9001', '2026-07-21', 'inv-cn-other', 'synthetic', 1000, 150, 1150)`),
    )
    try {
      expect((await plan("2026-07")).refusal).toMatchObject({ code: "AF_SOURCE_UNSUPPORTED", message: expect.stringContaining("AF-IS-CN01: a credit note against a tax invoice other than the inception") })
    } finally {
      await replica(db.$executeRawUnsafe(`DELETE FROM "CreditNote" WHERE "id" = 'cn-other'`), db.$executeRawUnsafe(`DELETE FROM "TaxInvoice" WHERE "id" = 'inv-cn-other'`))
    }
  })

  it("closes July with nothing of the credit note dated before its payout's release: the inception has not posted", async () => {
    const july = await plan("2026-07")
    expect(july.refusal).toBeNull()
    expect(july.entries.filter((e) => e.loanId === IS_CN_EARLY.loan.id)).toEqual([])
    await closeTied("2026-07")
  })

  it("refuses August, which posts the first price credit, until the mapping is confirmed again", async () => {
    expect((await plan("2026-08")).refusal).toMatchObject({ code: "MAPPING_NOT_CONFIRMED", message: expect.stringContaining("AF_PRICE_CREDITS") })
    await db.accountingSettings.update({ where: { tenantId: tenant.tenantId }, data: { mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
    expect((await plan("2026-08")).refusal).toBeNull()
  })

  it("posts and ties both inception credit notes in August, the early one dated by the payout's release", async () => {
    const august = await plan("2026-08")
    expect(august.entries.find((e) => e.baseKey === "af-credit:cn-is-early")).toMatchObject({ eventType: "CREDIT_NOTE", eventDate: new Date("2026-08-03T09:00:00+02:00") })
    await closeTied("2026-08")
    await expectWorked(IS_CN_EARLY)
    // Written off two days before its credit note: the credit lowers the write-off, and the written-off contract owes nil.
    await expectWorked(IS_CN_WO)
  })

  it("closes September and October; the ledger holds every hand-worked vector, the sale's credit note cleared to the result", async () => {
    await closeTied("2026-09")
    await expectWorked(IS_CN)
    await expectWorked(FL_CN)
    await closeTied("2026-10")
    await expectWorked(REC_SALE_CN)
  })

  it("posts credit notes the real issuer writes in November, the sale's after its proceeds were applied, and still ties", async () => {
    const isNote = await credit("inv-jrn-is-cn", "2026-11-10", 10_000)
    const saleNote = await credit("inv-sale-cn", "2026-11-10", 20_000)
    expect([isNote.vatCents, saleNote.vatCents]).toEqual([1_500, 3_000])
    const november = await plan("2026-11")
    expect(november.refusal).toBeNull()
    const vector = (key: string) => Object.fromEntries(november.entries.filter((e) => e.baseKey === key).flatMap((e) => e.lines.map((l) => [l.role, l.debitCents - l.creditCents])))
    expect(vector(`af-credit:${isNote.id}`)).toEqual({ AF_PRICE_CREDITS: 10_000, OUTPUT_VAT: 1_500, AF_INSTALMENT_DEBTORS: -11_500 })
    expect(vector(`af-recovery:r-cn:sale-credit:${saleNote.id}`)).toEqual({ OUTPUT_VAT: 3_000, RECOVERY_CLEARING: 20_000, BANK: -23_000 })
    // The recovery was resolved in October: its result takes the new credit's clearing with it.
    expect(vector("af-recovery:r-cn:result")).toEqual({ RECOVERY_CLEARING: -20_000, RECOVERY_RESULT: 20_000 })
    await closeTied("2026-11")
    const book = await runWithTenant(tenant.tenantId, () => independentBook(prisma, tenant.tenantId, day("2026-12-01")))
    // IS-CN: every row raised 1 020 067 - receipt 340 000 - credits 23 000 and 11 500
    expect(book.get(IS_CN.loan.id)?.cents).toBe(645_567)
  })
})
