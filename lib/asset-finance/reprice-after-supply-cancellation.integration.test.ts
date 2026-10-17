/** Combined B/D probe: issued rental rate adjustments, then cancellation of
 * that prepaid future rental. Synthetic real routes and immutable cash only. */
import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { sastCalendarDate } from "@/lib/date/sast"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { cleanupDealFixture } from "./deal.integration-fixture"
import { shiftLease } from "./lease-servicing.integration-fixture"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import { repriceLoanForReference } from "./reprice-loan"
import { quoteEarlyTermination, acceptEarlyTermination } from "./lease-termination-store"
import { loadAssetFinanceLoans } from "@/lib/accounting/store-asset-finance"
import { creditShares } from "@/lib/accounting/sources-asset-finance"
import { cancelSuppliedLeaseRateAdjustments } from "./lease-rate-tax-adjustment"
import { rateTaxDocuments } from "./rate-tax-documents"
import type { SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fixtures: LeaseFixture[] = []
suite.sequential("rate-adjusted prepaid future supply then commercial cancellation", () => {
  afterAll(async () => { for(const fx of fixtures){await cleanupLeaseRows(db,fx.tenantId).catch(()=>undefined);await cleanupDealFixture(db,{tenantId:fx.tenantId}).catch(()=>undefined)};await db.$disconnect() },60000)
  it.each([["OPERATING_LEASE",-.02,false],["FULL_MAINTENANCE_LEASE",.02,false],["OPERATING_LEASE",-.02,true],["FULL_MAINTENANCE_LEASE",.02,true]] as const)("%s rate adjustment %s, prepaid before rate %s, is accounted once against PV damages",async(contractType,change,prepaidFirst)=>{
    process.env.TRUSTED_PROXY="1"
    const fx=await createLeaseFixture(db,randomUUID().replaceAll("-","").slice(0,16));fixtures.push(fx)
    const setSession=(user:SessionUser|null)=>{session.current=user&&{user}}
    const staff=(id:string,role:"LOAN_ADMIN"|"CREDIT_OFFICER")=>setSession({id,email:`${id}@synthetic.invalid`,role,tenantId:fx.tenantId})
    const deal=await approveLease(fx,staff,leaseBody(fx,{assetId:fx.assets[0],contractType,rentalTiming:"ARREARS",entityId:fx.evidenced,preset:{kind:"MONTHLY",periods:12},escalationRate:"0"}))
    await signLease(fx,db,setSession,deal)
    const loanId=await payoutAndBook(fx,db,staff,deal)
    await shiftLease(db,loanId,"12 months - 7 days")
    const rows=await db.repaymentSchedule.findMany({where:{loanId},orderBy:{installmentNo:"asc"}})
    const receipt=(amount:number)=>applyManualReceipt(db as unknown as PaymentDb,{tenantId:fx.tenantId,loanId,amount,capturedById:fx.adminA})
    await receipt(rows.slice(0,-1).reduce((sum,row)=>sum+row.totalDue,0))
    const today=sastCalendarDate(new Date()), effectiveDate=new Date(dbDate(today).getTime()-86400000).toISOString().slice(0,10)
    const initial=await db.contractRate.findFirstOrThrow({where:{loanId},orderBy:{effectiveDate:"asc"}})
    const rate=new Prisma.Decimal(initial.resultingRate).add(change)
    const ref=await db.referenceRate.create({data:{tenantId:fx.tenantId,basis:"PRIME",effectiveDate:dbDate(effectiveDate),rate:rate.sub(initial.margin!),requestedById:fx.adminA}})
    await db.referenceRate.update({where:{id:ref.id},data:{status:"APPROVED",decidedById:fx.adminB,decidedAt:new Date()}})
    const last=await db.leaseRental.findFirstOrThrow({where:{loanId},orderBy:{periodNo:"desc"}})
    if(prepaidFirst)await receipt(last.totalCents)
    expect((await db.$transaction(tx=>repriceLoanForReference(tx as never,{tenantId:fx.tenantId,loanId,basis:"PRIME",effectiveDate,runDate:today,actorUserId:fx.adminA}))).kind).toBe("repriced")
    if(!prepaidFirst)await receipt(last.totalCents)
    const sources=await db.assetFinanceRateCorrection.findMany({where:{loanId,reason:{in:["LATE_CLOSED_LEASE_RATE","LEASE_SUPPLY_TAX_ADJUSTMENT"]}}})
    const adjustment=sources.flatMap(event=>rateTaxDocuments((event.contractualRows as Prisma.JsonObject).taxDocuments)).find(doc=>doc.periodNo===last.periodNo)!
    expect(adjustment).toBeDefined()
    const issued=adjustment.kind==="CREDIT_NOTE"?await db.creditNote.findUniqueOrThrow({where:{id:adjustment.id}}):await db.taxInvoice.findUniqueOrThrow({where:{id:adjustment.id}})
    const cashBefore=await db.payment.findMany({where:{loanId,reversed:false}})
    const grossCash=cashBefore.reduce((sum,p)=>sum+p.amount,0)
    const actor={tenantId:fx.tenantId,userId:fx.adminA}
    const quote=await db.$transaction(tx=>quoteEarlyTermination(tx as never,actor,{loanId,today}))
    expect(quote.kind).toBe("quoted")
    if(quote.kind!=="quoted")throw new Error("Synthetic cancellation quote failed")
    const accepted=await db.$transaction(tx=>acceptEarlyTermination(tx as never,actor,{quoteId:quote.quoteId,today}))
    expect(accepted.kind).toBe("accepted")
    const after=await db.loan.findUniqueOrThrow({where:{id:loanId},include:{payments:true,assetFinanceDeal:true}})
    const cash=after.payments.filter(p=>!p.reversed)
    expect(cash.reduce((sum,p)=>sum+p.amount,0)).toBe(grossCash)
    expect(cash.every(p=>cashBefore.some(original=>original.receivedAt.getTime()===p.receivedAt.getTime()&&original.paymentMethod===p.paymentMethod))).toBe(true)
    const original=await db.taxInvoice.findUniqueOrThrow({where:{id:adjustment.invoiceId}})
    const supplied=await db.taxInvoice.findMany({where:{tenantId:fx.tenantId,loanId,OR:[{id:original.id},{adjustedInvoiceId:original.id}]},include:{creditNotes:true}})
    const taxRemaining=supplied.reduce((sum,invoice)=>sum+invoice.totalInclVatCents-invoice.creditNotes.reduce((part,note)=>part+note.inclVatCents,0),0)
    expect.soft(taxRemaining,"superseded original and additional rental consideration are credited, independently of the new damages invoice").toBe(0)
    expect(adjustment.kind==="CREDIT_NOTE"?await db.creditNote.findUniqueOrThrow({where:{id:adjustment.id}}):await db.taxInvoice.findUniqueOrThrow({where:{id:adjustment.id}})).toEqual(issued)
    // Independent net claim: issued CN/DN defines the amended rental price;
    // discount its sole remaining payment and apply the signed commercial
    // penalty and per-line VAT, then credit the actual prepaid cash once.
    const amendedRental=last.rentalExclVatCents+adjustment.exclVatCents
    const days=toDayNumber(isoOfDbDate(last.dueDate))-toDayNumber(today)
    const pv=Math.round(amendedRental/(1+rate.toNumber()*days/365))
    const penalty=Math.round(pv*after.assetFinanceDeal!.earlyTerminationPenaltyRate!.toNumber())
    const lawfulDamages=pv+penalty+Math.round(pv*original.vatRate.toNumber())+Math.round(penalty*original.vatRate.toNumber())
    const held=cash.filter(p=>p.allocationStatus==="UNAPPLIED").reduce((sum,p)=>sum+p.amount,0)
    const pending=(await db.assetFinanceRateCorrection.aggregate({where:{loanId},_sum:{amountCents:true}}))._sum.amountCents??0
    const actualNet=after.totalRepayable-after.totalPaid-held+pending
    expect(pending,"cancelled future rate claim is replaced by amended PV damages").toBe(0)
    const eventCount=await db.assetFinanceRateCorrection.count({where:{loanId}})
    const noteCount=await db.creditNote.count({where:{tenantId:fx.tenantId}})
    await db.$transaction(tx=>cancelSuppliedLeaseRateAdjustments(tx as never,{tenantId:fx.tenantId,loanId,rentalIds:[last.id],today,actorUserId:fx.adminA}))
    expect(await db.assetFinanceRateCorrection.count({where:{loanId}})).toBe(eventCount)
    expect(await db.creditNote.count({where:{tenantId:fx.tenantId}})).toBe(noteCount)
    const accounting=await loadAssetFinanceLoans(db as unknown as Parameters<typeof loadAssetFinanceLoans>[0],fx.tenantId)
    const notes=accounting.loans.find(loan=>loan.id===loanId)!.assetFinance!.creditNotes.filter(note=>note.invoiceId===original.id)
    const maintenanceCredited=notes.flatMap(creditShares).filter(share=>share.role==="MAINTENANCE_INCOME").reduce((sum,share)=>sum+share.cents,0)
    expect(maintenanceCredited,"full future maintenance income reverses once, independent of rental-only rate credit").toBe(last.maintenanceExclVatCents)
    expect.soft(actualNet,"net executable claim after issued consideration changes, PV damages and all actual cash").toBe(lawfulDamages-last.totalCents)
  },120000)
})
