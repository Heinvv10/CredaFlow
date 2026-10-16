/**
 * Q3 of slice 4b, answered against a real database: an end-of-term or
 * early-termination invoice of a lease sits on the lease loan's receivable.
 * lib/asset-finance/lease-charges.ts appends it as a schedule row of the same
 * loan (and raises Loan.principal by it), so a receipt applies to it and the
 * export posts it to LEASE_DEBTORS like a rental (lease-invoice:<id> source,
 * and the lease branch of lib/accounting/reconcile-asset-finance.ts).
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/lease-receivable.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { afLoan, day, invoice } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { appendLeaseCharge } from "@/lib/asset-finance/lease-charges"
import type { SigningTx } from "@/lib/asset-finance/signing-prepare"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { insertSourceLoan, removeSourceLoans } from "./asset-finance.integration-fixture"
import { independentAssetFinanceBook } from "./reconcile-asset-finance"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant

const rental = (n: number, iso: string) => ({ id: `q3-rental${n}`, invoice: invoice(`inv-q3-${n}`, iso, 120_000, 18_000), rentalExclVatCents: 100_000, maintenanceExclVatCents: 20_000, vatCents: 18_000, totalCents: 138_000 })
const row = (n: number, iso: string) => ({ id: `q3-r${n}`, installmentNo: n, dueDate: day(iso), interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: 138_000, totalPaid: 0, openingBalanceCents: null })

suite.sequential("a lease's end-of-term invoice on the receivable (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await removeSourceLoans(db, ["jrn-q3"])
    await insertSourceLoan(db, tenant, afLoan({
      id: "jrn-q3", reference: "AF-Q3-0001", principal: 276_000, startDate: day("2026-07-01"), receivableRole: "LEASE_DEBTORS",
      schedule: [row(1, "2026-08-01"), row(2, "2026-09-01")],
      assetFinance: {
        contractType: "OPERATING_LEASE", financedFeesCents: 0, payout: null, inceptionInvoice: null, asset: { exclVatCents: 0, vatCents: 0 },
        rentals: [rental(1, "2026-08-01"), rental(2, "2026-09-01")], sundryInvoices: [invoice("inv-q3-eot", "2026-09-20", 25_000, 3_750)], creditNotes: [], fund: null, recoveries: [],
      },
    }))
  })
  afterAll(async () => { await removeSourceLoans(db, ["jrn-q3"]); await db.$disconnect() })

  it("appends the invoice total as a schedule row of the loan, which a receipt then pays", async () => {
    await db.leaseEndOfTerm.create({ data: { tenantId: tenant.tenantId, loanId: "jrn-q3", origin: "EXPIRY", outcome: "RETURN" } })
    await db.leaseEndOfTerm.update({ where: { loanId: "jrn-q3" }, data: { status: "INSPECTED", inspectedOn: new Date(`${sastCalendarDate(new Date())}T00:00:00Z`), inspectedById: tenant.userId, inspectionCondition: "Synthetic: good" } })
    const appended = await runWithTenant(tenant.tenantId, () => prisma.$transaction(async (tx) => {
      const id = await appendLeaseCharge(tx as unknown as SigningTx, { tenantId: tenant.tenantId, loanId: "jrn-q3", amountCents: 28_750, dueDate: "2026-09-27", actorUserId: null, why: "q3" })
      // As the end-of-term billing does next (lib/asset-finance/lease-end-invoice.ts): the invoice and its row are the end of term's.
      await tx.leaseEndOfTerm.update({ where: { loanId: "jrn-q3" }, data: { status: "INVOICED", taxInvoiceId: "inv-q3-eot", scheduleId: id } })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return id
    }))
    expect(appended).toBeTruthy()
    const loan = await db.loan.findUniqueOrThrow({ where: { id: "jrn-q3" }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    expect(loan.principal).toBe(276_000 + 28_750)
    expect(loan.repaymentSchedule.map((r) => r.totalDue)).toEqual([138_000, 138_000, 28_750])
    // A receipt fills the rentals first, then the end-of-term row: money reaches it.
    await applyManualReceipt(db as unknown as PaymentDb, { loanId: "jrn-q3", tenantId: tenant.tenantId, amount: 276_000 + 10_000, capturedById: tenant.userId, reference: "Q3" })
    const paid = await db.repaymentSchedule.findMany({ where: { loanId: "jrn-q3" }, orderBy: { installmentNo: "asc" } })
    expect(paid.map((r) => r.totalPaid)).toEqual([138_000, 138_000, 10_000])
  })

  it("the independent receivable of the lease counts the invoice with the rentals and nets the receipt", async () => {
    // The lease branch counts rentals invoiced + the other tax invoices - receipts.
    const book = await independentAssetFinanceBook(db, tenant.tenantId, day("2026-11-01"))
    expect(book.get("jrn-q3")?.cents).toBe(276_000 + 28_750 - 286_000) // two rentals + the end-of-term invoice - the receipt (10 000 reached the end-of-term row)
  })
})
