import { monthEndClamps, reportMonthEndSkip } from "./first-due.test-helpers"
import { randomUUID } from "node:crypto"
import { vatOnExclusive } from "@/lib/vat/amounts"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { cleanupDealFixture } from "./deal.integration-fixture"
import { backdateLease, shiftLease, testSetup, payAllOwed } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { issueLeaseRentalInvoice } from "./lease-invoices"
import { quoteEarlyTermination, acceptEarlyTermination } from "./lease-termination-store"
import { consumeDeferredLeaseRateTax } from "./lease-rate-tax-adjustment"
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
// Not on the 29th to the 31st: the lease it books ends a day early there (monthEndClamps)
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" && !monthEndClamps() ? describe : describe.skip
reportMonthEndSkip("closed booked lease late rates", process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1")
const db = new PrismaClient()
let fx: LeaseFixture
const fixtures: LeaseFixture[] = []
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-rate.test`, role, tenantId: fx.tenantId })
suite.sequential("closed booked lease late rates preserve ex-VAT capital and maintenance", () => {
  afterAll(async () => { for (const fixture of fixtures) { await cleanupLeaseRows(db,fixture.tenantId).catch(() => undefined); await cleanupDealFixture(db,{tenantId:fixture.tenantId}).catch(() => undefined) }; await db.$disconnect() },60000)
  it.each([
    ["OPERATING_LEASE",-.02,false,false,false], ["OPERATING_LEASE",.02,false,false,false], ["FULL_MAINTENANCE_LEASE",-.02,false,false,false], ["FULL_MAINTENANCE_LEASE",.02,false,false,false],
    ["OPERATING_LEASE",-.02,true,false,false], ["OPERATING_LEASE",.02,true,false,false], ["FULL_MAINTENANCE_LEASE",-.02,true,false,false], ["FULL_MAINTENANCE_LEASE",.02,true,false,false],
    ["OPERATING_LEASE",-.02,true,true,false], ["OPERATING_LEASE",.02,true,true,false], ["FULL_MAINTENANCE_LEASE",-.02,true,true,false], ["FULL_MAINTENANCE_LEASE",.02,true,true,false],
    ["OPERATING_LEASE",-.02,true,true,true], ["FULL_MAINTENANCE_LEASE",.02,true,true,true],
    ["OPERATING_LEASE",-.02,true,false,true], ["FULL_MAINTENANCE_LEASE",.02,true,false,true],
    ["OPERATING_LEASE",-.02,true,true,false,1600], ["FULL_MAINTENANCE_LEASE",.02,true,true,false,1600],
  ] as const)("%s signed adjustment %s, active %s future-only %s cancellation %s booked VAT %s", async (contractType, change, active, futureOnly, cancel, bookedVat: number=1500) => {
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
    if(bookedVat!==1500){
      const last=await db.leaseRental.findFirstOrThrow({where:{loanId},orderBy:{periodNo:"desc"}})
      const vat=vatOnExclusive(last.rentalExclVatCents,bookedVat)+vatOnExclusive(last.maintenanceExclVatCents,bookedVat)
      const total=last.rentalExclVatCents+last.maintenanceExclVatCents+vat, difference=total-last.totalCents
      // Fixture records the booking assumption before a real later supply;
      // every VAT/rental/receipt guard remains active during actual issuance.
      await testSetup(db,
        ['UPDATE "LeaseRental" SET "vatRate"=$2,"vatCents"=$3,"totalCents"=$4 WHERE "id"=$1',last.id,bookedVat/10000,vat,total],
        ['UPDATE "RepaymentSchedule" SET "principalDue"=$2,"totalDue"=$2 WHERE "id"=$1',last.scheduleId,total],
        ['UPDATE "Loan" SET "principal"="principal"+$2,"totalRepayable"="totalRepayable"+$2,"outstandingPrincipal"="outstandingPrincipal"+$2 WHERE "id"=$1',loanId,difference])
    }
    const before = await db.loan.findUniqueOrThrow({where:{id:loanId},include:{ repaymentSchedule:{orderBy:{installmentNo:"asc"}},leaseRentals:{orderBy:{periodNo:"asc"}},contractRates:{orderBy:{effectiveDate:"asc"}},taxInvoices:true,payments:true,maintenanceFund:{include:{movements:true}} }})
    expect(before.status).toBe(active?"ACTIVE":"COMPLETED")
    if(active){expect(toDayNumber(sastCalendarDate(before.repaymentSchedule.at(-1)!.dueDate))-toDayNumber(sastCalendarDate(new Date()))).toBe(7);expect(before.leaseRentals.at(-1)!.taxInvoiceId).toBeNull()}
    const initial = before.contractRates[0], annual = initial.resultingRate.toNumber()
    const runDate = sastCalendarDate(new Date()), effectiveDate = futureOnly ? new Date(dbDate(runDate).getTime()-86400000).toISOString().slice(0,10) : isoOfDbDate(before.leaseRentals[3].dueDate)
    const pending = await db.referenceRate.create({data:{tenantId:fx.tenantId,basis:"PRIME",effectiveDate:dbDate(effectiveDate),rate:new Prisma.Decimal(annual+change).sub(initial.margin!),requestedById:fx.adminA}})
    await db.referenceRate.update({where:{id:pending.id},data:{status:"APPROVED",decidedById:fx.adminB,decidedAt:new Date()}})
    // Independent daily Actual/365 oracle over rental-only cash; the retained
    // residual belongs to the lessor and is never a tenant cash receipt.
    const capital = before.repaymentSchedule[0].assetFinanceOpeningBalanceCents!
    const close = (delta:number, through=before.leaseRentals.length) => {
      let balance=capital, prior=toDayNumber(sastCalendarDate(before.startDate))
      for (const rental of before.leaseRentals.slice(0,through)) {
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
    const evidence=correction.contractualRows as {periodAdjustments:Array<{periodNo:number;exclVatCents:number}>;pendingTaxAdjustments:Array<{rentalId:string;periodNo:number;exclVatCents:number;estimatedGrossCents:number}>;exclVatAdjustmentCents:number;taxDocuments:Array<{periodNo:number;kind:string;id:string;invoiceId:string;exclVatCents:number;vatCents:number;inclVatCents:number}>}
    expect(evidence.exclVatAdjustmentCents).toBe(expectedExcl)
    expect(Math.sign(correction.amountCents)).toBe(Math.sign(change))
    expect(correction.amountCents).toBe(evidence.taxDocuments.reduce((s,d)=>s+d.inclVatCents,0)+evidence.pendingTaxAdjustments.reduce((s,d)=>s+d.estimatedGrossCents,0))
    for(const part of evidence.periodAdjustments){
      const i=part.periodNo
      const expected=(close(change,i)-close(0,i))-(i===1?0:close(change,i-1)-close(0,i-1))
      expect(part.exclVatCents).toBe(expected)
      expect(evidence.taxDocuments.filter(doc=>doc.periodNo===i).reduce((sum,doc)=>sum+doc.exclVatCents,0)+evidence.pendingTaxAdjustments.filter(item=>item.periodNo===i).reduce((sum,item)=>sum+item.exclVatCents,0)).toBe(expected)
    }
    expect(evidence.pendingTaxAdjustments.length).toBe(active?1:0)
    if(futureOnly)expect(evidence.taxDocuments).toEqual([])
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
      const response=change<0? await serveCreditNotePdf(db as never,req,{tenantId:fx.tenantId,id:doc.id},{type:"staff",id:fx.adminA}):await serveTaxInvoicePdf(db as never,req,{tenantId:fx.tenantId,invoiceId:doc.id},{type:"staff",id:fx.adminA})
      expect(response?.headers.get("Content-Type")).toBe("application/pdf")
      expect(await db.documentAccessLog.count({where:{documentId:doc.id,accessorId:fx.adminA}})).toBe(1)
    }
    const notice=await db.assetFinanceRateNotice.findFirstOrThrow({where:{loanId,tenantId:fx.tenantId}})
    const vars=rateNoticeVars(notice,{id:fx.lessee,firstName:"Synthetic",lastName:"Lessee",email:"lessee@synthetic.invalid"})
    if(!futureOnly){expect(vars.text).toContain(change<0?"CREDIT NOTE":"DEBIT NOTE");expect(vars.text).toContain("Original transaction: tax invoice");expect(vars.text).toContain("VAT 4000000001")}
    expect(notice.taxAdjustmentPending).toBe(active)
    if(active)expect(vars.text).toContain("awaiting its actual supply")
    const after=await db.loan.findUniqueOrThrow({where:{id:loanId},include:{leaseRentals:{orderBy:{periodNo:"asc"}},payments:true,maintenanceFund:{include:{movements:true}}}})
    expect(after.leaseRentals).toEqual(before.leaseRentals)
    expect(after.payments).toEqual(before.payments)
    expect(after.maintenanceFund).toEqual(before.maintenanceFund)
    expect(after.principal).toBe(before.principal)
    expect(after.status).toBe(before.status)
    if(active)expect(await db.repaymentSchedule.findMany({where:{loanId},orderBy:{installmentNo:"asc"}})).toEqual(before.repaymentSchedule)
    expect(await db.$transaction(tx=>repriceLoanForReference(tx as unknown as RepriceTx,request))).toEqual({kind:"already_repriced"})
    expect(await db.assetFinanceRateCorrection.count({where:{tenantId:fx.tenantId,loanId}})).toBe(1)
    if(active){
      const last=before.leaseRentals.at(-1)!, pending=evidence.pendingTaxAdjustments[0]
      const priorDocs=evidence.taxDocuments.length
      if(cancel){
        const actor={tenantId:fx.tenantId,userId:fx.adminA}
        const quoted=await db.$transaction(tx=>quoteEarlyTermination(tx as never,actor,{loanId,today:runDate}))
        expect(quoted.kind).toBe("quoted")
        if(quoted.kind!=="quoted")throw new Error("Synthetic cancellation quote failed")
        expect((await db.$transaction(tx=>acceptEarlyTermination(tx as never,actor,{quoteId:quoted.quoteId,today:runDate}))).kind).toBe("accepted")
        expect((await db.leaseRental.findUniqueOrThrow({where:{id:last.id}})).taxInvoiceId).toBeNull()
        const cancelled=await db.assetFinanceRateCorrection.findFirstOrThrow({where:{loanId,reason:"LEASE_SUPPLY_TAX_CANCELLED"}})
        expect(cancelled.amountCents).toBe(-pending.estimatedGrossCents)
        expect((await db.assetFinanceRateCorrection.aggregate({where:{loanId},_sum:{amountCents:true}}))._sum.amountCents).toBe(correction.amountCents-pending.estimatedGrossCents)
        await db.$transaction(tx=>consumeDeferredLeaseRateTax(tx as never,{tenantId:fx.tenantId,loanId,rentalIds:[last.id],today:runDate,actorUserId:fx.adminA}))
        expect(await db.assetFinanceRateCorrection.count({where:{loanId,reason:"LEASE_SUPPLY_TAX_CANCELLED"}})).toBe(1)
      }else{
        const supplyDay=runDate
        {
          // Receipt is the actual earlier supply under s9(3)(a); no clock or
          // future supply date is invented for the database.
          await applyManualReceipt(db as unknown as PaymentDb,{tenantId:fx.tenantId,loanId,amount:last.totalCents,capturedById:fx.adminA})
          const event=await db.assetFinanceRateCorrection.findFirstOrThrow({where:{loanId,reason:"LEASE_SUPPLY_TAX_ADJUSTMENT"}})
          const docs=(event.contractualRows as {taxDocuments:Array<{invoiceId:string;exclVatCents:number;vatCents:number;inclVatCents:number}>}).taxDocuments
          expect(docs).toHaveLength(1)
          const invoice=await db.taxInvoice.findUniqueOrThrow({where:{id:docs[0].invoiceId}})
          expect(invoice.supplyDate).toEqual(dbDate(runDate))
          expect(docs[0].exclVatCents).toBe(pending.exclVatCents)
          expect(Math.abs(docs[0].vatCents)).toBe(Math.round(Math.abs(pending.exclVatCents)*invoice.vatRate.toNumber()))
          expect(event.amountCents).toBe(docs[0].inclVatCents-pending.estimatedGrossCents)
          if(bookedVat!==1500){
            expect(event.amountCents).not.toBe(0)
            expect(invoice.vatRate.toNumber()).toBe(.15)
            const rental=await db.leaseRental.findUniqueOrThrow({where:{id:last.id},include:{schedule:true}})
            expect(rental.vatRate.toNumber()).toBe(.15)
            expect(rental.schedule.totalPaid).toBeLessThanOrEqual(rental.schedule.totalDue)
            expect((await db.payment.aggregate({where:{loanId,reversed:false},_sum:{amount:true}}))._sum.amount).toBe(before.totalPaid+last.totalCents)
          }
          expect((await db.assetFinanceRateCorrection.aggregate({where:{loanId},_sum:{amountCents:true}}))._sum.amountCents).toBe(correction.amountCents+event.amountCents)
          expect((await db.$transaction(tx=>issueLeaseRentalInvoice(tx as never,{tenantId:fx.tenantId,rentalId:last.id,supplyDate:supplyDay,today:supplyDay,createdById:fx.adminA,source:"cron"}))).kind).toBe("already_invoiced")
          expect(await db.assetFinanceRateCorrection.count({where:{loanId,reason:"LEASE_SUPPLY_TAX_ADJUSTMENT"}})).toBe(1)
        }
      }
      const delivered=await db.assetFinanceRateNotice.findUniqueOrThrow({where:{id:notice.id}})
      expect(delivered.taxAdjustmentPending).toBe(false)
      expect(delivered.taxAdjustmentRevision).toBe(1)
      expect((delivered.taxDocuments as unknown[]).length).toBe(priorDocs+(cancel?0:1))
      expect(delivered.completedAt).toBeNull()
    }
  },120000)
})
