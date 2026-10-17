import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { cleanupDealFixture } from "./deal.integration-fixture"
import { backdateLease, shiftLease, payAllOwed } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { repriceLoanForReference, type RepriceTx } from "./reprice-loan"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import { loadAssetFinanceLoans } from "@/lib/accounting/store-asset-finance"
import { creditShares } from "@/lib/accounting/sources-asset-finance"
import { serveCreditNotePdf } from "@/lib/vat/credit-note-serve"
import { serveTaxInvoicePdf } from "@/lib/vat/tax-invoice-serve"
import { rateNoticeVars } from "./reprice-notice-dispatch"
import { sastCalendarDate } from "@/lib/date/sast"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let fx: LeaseFixture
const fixtures: LeaseFixture[] = []
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-rate.test`, role, tenantId: fx.tenantId })
suite.sequential("closed booked lease late rates preserve ex-VAT capital and maintenance", () => {
  afterAll(async () => { for (const fixture of fixtures) { await cleanupLeaseRows(db,fixture.tenantId).catch(() => undefined); await cleanupDealFixture(db,{tenantId:fixture.tenantId}).catch(() => undefined) }; await db.$disconnect() },60000)
  it.each([
    ["OPERATING_LEASE",-.02,false], ["OPERATING_LEASE",.02,false], ["FULL_MAINTENANCE_LEASE",-.02,false], ["FULL_MAINTENANCE_LEASE",.02,false],
    ["OPERATING_LEASE",-.02,true], ["OPERATING_LEASE",.02,true], ["FULL_MAINTENANCE_LEASE",-.02,true], ["FULL_MAINTENANCE_LEASE",.02,true],
  ] as const)("%s signed adjustment %s, active final window %s, uses original rental tax documents", async (contractType, change, active) => {
    process.env.TRUSTED_PROXY = "1"; fx = await createLeaseFixture(db, randomUUID().replaceAll("-", "").slice(0,16)); fixtures.push(fx)
    const dealId = await approveLease(fx,staff,leaseBody(fx,{ assetId:fx.assets[0], contractType,rentalTiming:"ARREARS",entityId:fx.evidenced,preset:{kind:"MONTHLY",periods:12},escalationRate:"0" }))
    await signLease(fx,db,setSession,dealId)
    const loanId = await payoutAndBook(fx,db,staff,dealId)
    if (active) {
      await shiftLease(db,loanId,"12 months - 7 days")
      const rows=await db.repaymentSchedule.findMany({where:{loanId},orderBy:{installmentNo:"asc"}})
      await applyManualReceipt(db as unknown as PaymentDb,{tenantId:fx.tenantId,loanId,amount:rows.slice(0,-1).reduce((sum,row)=>sum+row.totalDue,0),capturedById:fx.adminA})
    } else {
      await backdateLease(db,loanId,24)
      await payAllOwed(db,fx,loanId)
    }
    const before = await db.loan.findUniqueOrThrow({where:{id:loanId},include:{ repaymentSchedule:{orderBy:{installmentNo:"asc"}},leaseRentals:{orderBy:{periodNo:"asc"}},contractRates:{orderBy:{effectiveDate:"asc"}},taxInvoices:true,payments:true,maintenanceFund:{include:{movements:true}} }})
    expect(before.status).toBe(active?"ACTIVE":"COMPLETED")
    if(active){expect(toDayNumber(sastCalendarDate(before.repaymentSchedule.at(-1)!.dueDate))-toDayNumber(sastCalendarDate(new Date()))).toBe(7);expect(before.leaseRentals.at(-1)!.taxInvoiceId).toBeNull()}
    const initial = before.contractRates[0], annual = initial.resultingRate.toNumber()
    const effectiveDate = isoOfDbDate(before.leaseRentals[3].dueDate), runDate = sastCalendarDate(new Date())
    const pending = await db.referenceRate.create({data:{tenantId:fx.tenantId,basis:"PRIME",effectiveDate:dbDate(effectiveDate),rate:new Prisma.Decimal(annual+change).sub(initial.margin!),requestedById:fx.adminA}})
    await db.referenceRate.update({where:{id:pending.id},data:{status:"APPROVED",decidedById:fx.adminB,decidedAt:new Date()}})
    // Independent daily Actual/365 oracle over rental-only cash; the retained
    // residual belongs to the lessor and is never a tenant cash receipt.
    const capital = before.repaymentSchedule[0].assetFinanceOpeningBalanceCents!
    const close = (delta:number) => {
      let balance=capital, prior=toDayNumber(sastCalendarDate(before.startDate))
      for (const rental of before.leaseRentals) {
        const day=toDayNumber(isoOfDbDate(rental.dueDate)); let rateDays=0
        for(let d=prior+1;d<=day;d++) rateDays+=annual+(d>=toDayNumber(effectiveDate)?delta:0)
        balance+=Math.round(Math.max(0,balance)*rateDays/365)-rental.rentalExclVatCents;prior=day
      }
      return balance
    }
    expect(close(0)).toBe(30000000)
    const expectedExcl=close(change)-close(0)
    const request={tenantId:fx.tenantId,loanId,basis:"PRIME" as const,effectiveDate,runDate,actorUserId:fx.adminA}
    const outcome=await db.$transaction(tx=>repriceLoanForReference(tx as unknown as RepriceTx,request),{timeout:60000})
    expect(outcome).toMatchObject({kind:"repriced",rowsRepriced:0})
    const correction=await db.assetFinanceRateCorrection.findFirstOrThrow({where:{tenantId:fx.tenantId,loanId}})
    const evidence=correction.contractualRows as {exclVatAdjustmentCents:number;taxDocuments:Array<{kind:string;id:string;invoiceId:string;exclVatCents:number;vatCents:number;inclVatCents:number}>}
    expect(evidence.exclVatAdjustmentCents).toBe(expectedExcl)
    expect(Math.sign(correction.amountCents)).toBe(Math.sign(change))
    expect(correction.amountCents).toBe(evidence.taxDocuments.reduce((s,d)=>s+d.inclVatCents,0))
    for(const doc of evidence.taxDocuments){
      const original=before.taxInvoices.find(i=>i.id===doc.invoiceId)!
      expect(Math.abs(doc.vatCents)).toBe(Math.round(Math.abs(doc.exclVatCents)*original.vatRate.toNumber()))
      if(change>0){const debit=await db.taxInvoice.findUniqueOrThrow({where:{id:doc.id}});expect(debit).toMatchObject({adjustmentKind:"DEBIT_NOTE",adjustedInvoiceId:original.id,supplyDate:original.supplyDate});expect(debit.invoiceNumber).toMatch(/^DN-/)}
      else {expect((await db.creditNote.findUniqueOrThrow({where:{id:doc.id}})).invoiceId).toBe(original.id)}
    }
    const source = await loadAssetFinanceLoans(db as never,fx.tenantId)
    expect(source.unsupported).toEqual([])
    const af=source.loans.find(loan=>loan.id===loanId)!.assetFinance!
    for(const doc of evidence.taxDocuments){
      if(change<0){
        const credit=af.creditNotes.find(note=>note.id===doc.id)!
        expect(creditShares(credit)).toEqual([{role:"RENTAL_INCOME",cents:Math.abs(doc.exclVatCents)}])
      } else expect(sastCalendarDate(af.sundryInvoices.find(invoice=>invoice.id===doc.id)!.supplyDate)).toBe(runDate)
      const req=new Request("http://synthetic.invalid/tax-document")
      const response=change<0? await serveCreditNotePdf(db,req,{tenantId:fx.tenantId,id:doc.id},{type:"staff",id:fx.adminA}):await serveTaxInvoicePdf(db,req,{tenantId:fx.tenantId,invoiceId:doc.id},{type:"staff",id:fx.adminA})
      expect(response?.headers.get("Content-Type")).toBe("application/pdf")
      expect(await db.documentAccessLog.count({where:{documentId:doc.id,accessorId:fx.adminA}})).toBe(1)
    }
    const notice=await db.assetFinanceRateNotice.findFirstOrThrow({where:{loanId,tenantId:fx.tenantId}})
    const vars=rateNoticeVars(notice,{id:fx.lessee,firstName:"Synthetic",lastName:"Lessee",email:"lessee@synthetic.invalid"})
    expect(vars.text).toContain(change<0?"CREDIT NOTE":"DEBIT NOTE")
    expect(vars.text).toContain("Original transaction: tax invoice")
    expect(vars.text).toContain("VAT 4000000001")
    const after=await db.loan.findUniqueOrThrow({where:{id:loanId},include:{leaseRentals:{orderBy:{periodNo:"asc"}},payments:true,maintenanceFund:{include:{movements:true}}}})
    expect(after.leaseRentals).toEqual(before.leaseRentals)
    expect(after.payments).toEqual(before.payments)
    expect(after.maintenanceFund).toEqual(before.maintenanceFund)
    expect(after.principal).toBe(before.principal)
    expect(after.status).toBe(before.status)
    if(active)expect(await db.repaymentSchedule.findMany({where:{loanId},orderBy:{installmentNo:"asc"}})).toEqual(before.repaymentSchedule)
    expect(await db.$transaction(tx=>repriceLoanForReference(tx as unknown as RepriceTx,request))).toEqual({kind:"already_repriced"})
    expect(await db.assetFinanceRateCorrection.count({where:{tenantId:fx.tenantId,loanId}})).toBe(1)
  },120000)
})
