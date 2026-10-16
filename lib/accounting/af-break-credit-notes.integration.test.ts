/**
 * BREAK F3 (RUN_ACCOUNTING_IT): edge cases of the credit-note sources on an inception invoice and a remarketing-sale invoice.
 * Each scenario has its own lender; months are closed through the real planner and closePeriod, credit notes through the real issuer.
 */
import { afterAll, describe, expect, it } from "vitest"
import { CREDIT_NOTE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-credit-note-deals"
import { LEASE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-lease-deals"
import { day } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { issueCreditNote } from "@/lib/vat/credit-note"
import { closeMonths, db, dropLender, ledgerOfLoan, newLender, planOf, renamed, RUN, type Lender } from "./af-break.fixture"
import { independentBook } from "./reconcile"
import type { SourceLoan } from "./source-types"

const suite = RUN ? describe : describe.skip
const [IS_CN, , REC_SALE_CN] = CREDIT_NOTE_JOURNAL_DEALS
const lenders: Lender[] = []
const make = async (loans: SourceLoan[], confirmed = true) => { const l = await newLender(loans, confirmed); lenders.push(l); return l }
afterAll(async () => { for (const l of lenders) await dropLender(l); await db.$disconnect() }, 120_000)

const bare = (s: string): SourceLoan => {
  const loan = renamed(IS_CN.loan, s)
  loan.assetFinance = { ...loan.assetFinance!, creditNotes: [] }
  return loan
}
const note = (l: Lender, invoiceId: string, issueDate: string, exclVatCents: number) =>
  prisma.$transaction((tx) => issueCreditNote(tx as never, { tenantId: l.tenant.tenantId, invoiceId, issueDate, reason: "Synthetic", exclVatCents, createdById: l.tenant.userId }))
const book = (l: Lender, loanId: string, asOf: string) => runWithTenant(l.tenant.tenantId, () => independentBook(prisma, l.tenant.tenantId, day(asOf))).then((b) => b.get(loanId)?.cents)
const summary = (outcomes: Awaited<ReturnType<typeof closeMonths>>) => outcomes.map((o) => `${o.key}:${o.closed ? "ok" : o.code}:c${o.controls}:m${o.mismatches}`)
const ok = (...keys: string[]) => keys.map((k) => `${k}:ok:c0:m0`)

suite.sequential("F3 credit-note breakers", () => {
  it("R1. two partial notes and a full-remaining note on one inception invoice close and tie", async () => {
    const loan = bare("r1")
    const l = await make([loan])
    const inv = loan.assetFinance!.inceptionInvoice!.id
    await note(l, inv, "2026-08-20", 20_000)
    await note(l, inv, "2026-08-25", 30_000)
    await note(l, inv, "2026-09-10", 950_000)
    expect(summary(await closeMonths(l.tenant, ["2026-08", "2026-09", "2026-10", "2026-11"]))).toEqual(ok("2026-08", "2026-09", "2026-10", "2026-11"))
    const led = await ledgerOfLoan(l.tenant.tenantId, loan.id)
    expect(led.AF_PRICE_CREDITS).toBe(1_000_000)
    expect(led.OUTPUT_VAT).toBe(150_000) // the inception (07-15) is in the opening entry; only the credits are in closed batches
    // OBSERVATION: the whole invoice credited, but the debtor paid a deposit outside the contract: the debtors control goes negative
    expect(await book(l, loan.id, "2026-12-01")).toBe(1_000_000 + 20_067 - 340_000 - 1_150_000)
  }, 180_000)

  it("R2. a credit note back-dated into a closed month posts in the next open month and ties", async () => {
    const loan = bare("r2")
    const l = await make([loan])
    expect(summary(await closeMonths(l.tenant, ["2026-08", "2026-09"]))).toEqual(ok("2026-08", "2026-09"))
    await note(l, loan.assetFinance!.inceptionInvoice!.id, "2026-08-20", 20_000)
    const oct = await planOf(l.tenant, "2026-10")
    expect(oct.refusal).toBeNull()
    expect(oct.controls).toEqual([])
    expect(oct.reconciliation.mismatches).toEqual([])
    expect(summary(await closeMonths(l.tenant, ["2026-10", "2026-11"]))).toEqual(ok("2026-10", "2026-11"))
  }, 180_000)

  it("R3. a credit note after a write-off, and one after settlement, close and tie", async () => {
    const wo = bare("r3w"); wo.status = "WRITTEN_OFF"; wo.writeOffAt = day("2026-08-18")
    const done = bare("r3s"); done.status = "COMPLETED"; done.closedAt = day("2026-09-01")
    const l = await make([wo, done])
    await note(l, wo.assetFinance!.inceptionInvoice!.id, "2026-08-20", 20_000)
    await note(l, wo.assetFinance!.inceptionInvoice!.id, "2026-10-20", 20_000)
    await note(l, done.assetFinance!.inceptionInvoice!.id, "2026-09-20", 20_000)
    expect(summary(await closeMonths(l.tenant, ["2026-08", "2026-09", "2026-10", "2026-11"]))).toEqual(ok("2026-08", "2026-09", "2026-10", "2026-11"))
  }, 180_000)

  it("R4. credit notes on the buyer's invoice dated before the sale and before the proceeds tie with clearing at nil", async () => {
    const loan = renamed(REC_SALE_CN.loan, "r4")
    const l = await make([loan])
    const inv = loan.assetFinance!.recoveries[0].sale!.invoice.id
    await note(l, inv, "2026-10-01", 10_000)
    await note(l, inv, "2026-10-10", 5_000)
    expect(summary(await closeMonths(l.tenant, ["2026-08", "2026-09", "2026-10", "2026-11"]))).toEqual(ok("2026-08", "2026-09", "2026-10", "2026-11"))
  }, 180_000)

  it("R5. a buyer-invoice credit note back-dated into October after the result closed there still nets clearing to nil", async () => {
    const loan = renamed(REC_SALE_CN.loan, "r5")
    const l = await make([loan])
    expect(summary(await closeMonths(l.tenant, ["2026-08", "2026-09", "2026-10"]))).toEqual(ok("2026-08", "2026-09", "2026-10"))
    await note(l, loan.assetFinance!.recoveries[0].sale!.invoice.id, "2026-10-20", 7_000)
    expect(summary(await closeMonths(l.tenant, ["2026-11"]))).toEqual(ok("2026-11"))
    expect((await ledgerOfLoan(l.tenant.tenantId, loan.id)).RECOVERY_CLEARING ?? 0).toBe(0)
  }, 180_000)

  it("R6. lease credit path unchanged; a consumer loan's invoice credit is not picked up", async () => {
    const [LS, LR] = LEASE_JOURNAL_DEALS
    const l = await make([renamed(LS.loan, "r6a"), renamed(LR.loan, "r6b")])
    const plan = await planOf(l.tenant, "2026-10")
    expect(plan.entries.some((e) => e.baseKey.startsWith("af-credit:"))).toBe(false)
    expect(plan.controls).toEqual([])

    const consumer = await createChargesTenant(db, false)
    const cl = await createChargesLoan(db, consumer)
    await db.accountingSettings.create({ data: { tenantId: consumer.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08" } })
    const shape = (p: Awaited<ReturnType<typeof planOf>>) => p.entries.map((e) => [e.baseKey, e.lines.map((x) => x.debitCents - x.creditCents)])
    const before = await planOf(consumer, "2026-09")
    const replica = (...ops: Array<ReturnType<typeof db.$executeRawUnsafe>>) => db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"), ...ops])
    await replica(
      db.$executeRawUnsafe(`INSERT INTO "TaxInvoice" ("id","tenantId","number","invoiceNumber","issueDate","supplyDate","loanId","supplierName","supplierAddress","supplierVatNumber","recipientName","recipientAddress","vatRate","totalExclVatCents","vatCents","totalInclVatCents")
        VALUES ('inv-cons-r6','${consumer.tenantId}',9101,'INV-9101','2026-08-20','2026-08-20','${cl.loanId}','TEST','1 Test St','4000000001','TEST','2 Test Rd',0.15,1000,150,1150)`),
      db.$executeRawUnsafe(`INSERT INTO "CreditNote" ("id","tenantId","number","creditNoteNumber","issueDate","invoiceId","reason","exclVatCents","vatCents","inclVatCents")
        VALUES ('cn-cons-r6','${consumer.tenantId}',9101,'CN-9101','2026-08-21','inv-cons-r6','x',1000,150,1150)`),
    )
    try {
      const after = await planOf(consumer, "2026-09")
      expect(after.refusal?.code ?? null).toBe(before.refusal?.code ?? null)
      expect(shape(after)).toEqual(shape(before))
      expect(after.controls).toEqual([])
    } finally {
      await replica(db.$executeRawUnsafe(`DELETE FROM "CreditNote" WHERE "id"='cn-cons-r6'`), db.$executeRawUnsafe(`DELETE FROM "TaxInvoice" WHERE "id"='inv-cons-r6'`))
    }
  }, 180_000)

  it("R7. a credit note dated before go-live (inception also before go-live) carries into the opening and the first closes tie", async () => {
    const loan = bare("r7")
    const l = await make([loan])
    await note(l, loan.assetFinance!.inceptionInvoice!.id, "2026-07-20", 10_000)
    expect(summary(await closeMonths(l.tenant, ["2026-08", "2026-09"]))).toEqual(ok("2026-08", "2026-09"))
  }, 180_000)

  it("R8. cross-tenant: tenant B's credit notes leave tenant A's plan and controls as they were", async () => {
    const a = await make([bare("r8a")])
    const bLoans = [bare("r8b")]
    const b = await make(bLoans)
    const beforeA = await planOf(a.tenant, "2026-09")
    await note(b, bLoans[0].assetFinance!.inceptionInvoice!.id, "2026-08-20", 20_000)
    const afterA = await planOf(a.tenant, "2026-09")
    expect(afterA.controls).toEqual(beforeA.controls)
    expect(afterA.entries.map((e) => e.baseKey).sort()).toEqual(beforeA.entries.map((e) => e.baseKey).sort())
    expect(summary(await closeMonths(a.tenant, ["2026-08", "2026-09"]))).toEqual(ok("2026-08", "2026-09"))
    expect(summary(await closeMonths(b.tenant, ["2026-08", "2026-09"]))).toEqual(ok("2026-08", "2026-09"))
  }, 180_000)

  it("R9. a tenant with NULL mappingConfirmedRoles posting a price credit is refused", async () => {
    const loan = bare("r9")
    loan.assetFinance = { ...loan.assetFinance!, creditNotes: IS_CN.loan.assetFinance!.creditNotes.map((n) => ({ ...n, id: `${n.id}-r9`, invoiceId: loan.assetFinance!.inceptionInvoice!.id })) }
    const l = await make([loan], false)
    expect((await planOf(l.tenant, "2026-08")).refusal?.code).toBe("MAPPING_NOT_CONFIRMED")
  }, 180_000)
  it("R10. a write-off posted in a closed month, then a credit larger than what was written off, ties", async () => {
    const wo = bare("r10"); wo.status = "WRITTEN_OFF"; wo.writeOffAt = day("2026-08-18")
    const l = await make([wo])
    expect(summary(await closeMonths(l.tenant, ["2026-08"]))).toEqual(ok("2026-08"))
    await note(l, wo.assetFinance!.inceptionInvoice!.id, "2026-09-10", 1_000_000)
    expect(summary(await closeMonths(l.tenant, ["2026-09", "2026-10", "2026-11"]))).toEqual(ok("2026-09", "2026-10", "2026-11"))
  }, 180_000)

  it("R11. the buyer's invoice credited in full, in a month after the result closed, ties", async () => {
    const loan = renamed(REC_SALE_CN.loan, "r11")
    const l = await make([loan])
    expect(summary(await closeMonths(l.tenant, ["2026-08", "2026-09", "2026-10"]))).toEqual(ok("2026-08", "2026-09", "2026-10"))
    await note(l, loan.assetFinance!.recoveries[0].sale!.invoice.id, "2026-11-03", 760_000) // 800 000 less the 40 000 already credited
    expect(summary(await closeMonths(l.tenant, ["2026-11"]))).toEqual(ok("2026-11"))
    expect((await ledgerOfLoan(l.tenant.tenantId, loan.id)).RECOVERY_CLEARING ?? 0).toBe(0)
  }, 180_000)

  it("R12. credits on the release day, the day before a month end and the first of the next month land in the right months", async () => {
    const loan = bare("r12")
    const l = await make([loan])
    const inv = loan.assetFinance!.inceptionInvoice!.id
    await note(l, inv, "2026-07-15", 1_000) // the release day (09:00)
    await note(l, inv, "2026-08-31", 2_000)
    await note(l, inv, "2026-09-01", 4_000)
    const aug = await planOf(l.tenant, "2026-08")
    const credit = (p: typeof aug) => p.entries.filter((e) => e.baseKey.startsWith("af-credit:")).flatMap((e) => e.lines.filter((x) => x.role === "AF_PRICE_CREDITS").map((x) => x.debitCents))
    expect(credit(aug)).toEqual([2_000]) // the 07-15 credit is before go-live: in the opening
    expect(summary(await closeMonths(l.tenant, ["2026-08", "2026-09"]))).toEqual(ok("2026-08", "2026-09"))
  }, 180_000)

  it("R13. confirmed before the role existed, a back-dated price credit blocks the next close until the mapping is confirmed again", async () => {
    const loan = bare("r13")
    const l = await make([loan])
    await db.accountingSettings.update({ where: { tenantId: l.tenant.tenantId }, data: { mappingConfirmedRoles: { set: (await import("./accounts")).ASSET_FINANCE_ROLES.filter((r) => r !== "AF_PRICE_CREDITS") } } })
    expect(summary(await closeMonths(l.tenant, ["2026-08"]))).toEqual(ok("2026-08"))
    await note(l, loan.assetFinance!.inceptionInvoice!.id, "2026-08-20", 20_000)
    expect((await planOf(l.tenant, "2026-09")).refusal?.code).toBe("MAPPING_NOT_CONFIRMED")
  }, 180_000)
})
