/** Legal gaps 13, 14 and 25, through the real migrated ledger and tax-invoice service. Synthetic only. */
import { monthEndClamps } from "./first-due.test-helpers"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { backdateLease, testSetup } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { issueLeaseRentalInvoice } from "./lease-invoices"
import { vatOnExclusive } from "@/lib/vat/amounts"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const db = RUN ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT required"); return db }
// Not on the 29th to the 31st: the lease it books ends a day early there (monthEndClamps)
const suite = RUN && !monthEndClamps() ? describe : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans: string[] = []
const today = () => sastCalendarDate(new Date())
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
suite.sequential("lease legal calculations applied to actual accounts", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    for (const assetId of fx.assets.slice(0, 4)) {
      const id = await approveLease(fx, staff, leaseBody(fx, { assetId, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", ...(assetId === fx.assets[3] ? { clientId: fx.lessee } : { entityId: fx.evidenced }) }))
      await signLease(fx, database(), setSession, id)
      loans.push(await payoutAndBook(fx, database(), staff, id))
    }
    const source = await database().financedAsset.findUniqueOrThrow({ where: { id: fx.assets[3] } })
    for (const label of ["PREPAID", "RECOVERY"]) {
      const asset = await database().financedAsset.create({ data: { ...source, id: undefined, serialNumber: `SYN-${label}-${t}`, vin: null, registrationNumber: null, lessorStatus: null, releasedAt: null } })
      const deal = await approveLease(fx, staff, leaseBody(fx, { assetId: asset.id, contractType: label === "PREPAID" ? "FULL_MAINTENANCE_LEASE" : "OPERATING_LEASE", rentalTiming: "ARREARS", ...(label === "PREPAID" ? { clientId: fx.lessee, maintenanceRiskModel: "LESSEE_SETTLED" } : { entityId: fx.evidenced }) }))
      await signLease(fx, database(), setSession, deal)
      loans.push(await payoutAndBook(fx, database(), staff, deal))
    }

  }, 600_000)
  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)
  it.each([[0,1600,false],[1,1400,false],[2,1600,true],[3,1400,true]] as const)("replays paid rental VAT at booked rate %s / %s, fully paid %s", async (index, bookedVat, full) => {
    const id=loans[index]
    await backdateLease(database(),id,1)
    const rental=await database().leaseRental.findFirstOrThrow({where:{loanId:id},orderBy:{periodNo:"asc"}})
    const fakeVat=vatOnExclusive(rental.rentalExclVatCents,bookedVat), fakeTotal=rental.rentalExclVatCents+fakeVat
    const delta=fakeTotal-rental.totalCents
    await testSetup(database(),
      ['UPDATE "LeaseRental" SET "vatRate" = $2, "vatCents" = $3, "totalCents" = $4 WHERE "id" = $1',rental.id,bookedVat/10000,fakeVat,fakeTotal],
      ['UPDATE "RepaymentSchedule" SET "principalDue" = $2, "totalDue" = $2 WHERE "id" = $1',rental.scheduleId,fakeTotal],
      ['UPDATE "Loan" SET "principal" = "principal" + $2, "totalRepayable" = "totalRepayable" + $2, "outstandingPrincipal" = "outstandingPrincipal" + $2 WHERE "id" = $1',id,delta])
    const old=await database().loan.findUniqueOrThrow({where:{id},include:{repaymentSchedule:{orderBy:{installmentNo:"asc"}}}})
    // A real receipt may precede a delayed invoice. Missing recipient address
    // gives the real invoicer's recoverable refusal, without hiding its gates.
    await testSetup(database(),...(old.entityId ? [[`UPDATE "BusinessEntity" SET "addressLine1" = NULL WHERE "id" = $1`,old.entityId] as [string,...unknown[]]] : [[`UPDATE "Client" SET "addressLine1" = NULL WHERE "id" = $1`,old.clientId] as [string,...unknown[]]]))
    const cash=full?old.totalRepayable:fakeTotal
    await applyManualReceipt(database() as unknown as PaymentDb,{tenantId:fx.tenantId,loanId:id,amount:cash,capturedById:fx.adminA,reference:"SYNTHETIC-SUPPLY-VAT"})
    await testSetup(database(),...(old.entityId ? [[`UPDATE "BusinessEntity" SET "addressLine1" = '9 Synthetic Yard' WHERE "id" = $1`,old.entityId] as [string,...unknown[]]] : [[`UPDATE "Client" SET "addressLine1" = '9 Synthetic Yard' WHERE "id" = $1`,old.clientId] as [string,...unknown[]]]))
    expect((await database().loan.findUniqueOrThrow({where:{id}})).status).toBe(full?"COMPLETED":"ACTIVE")
    const cashHistory=await database().payment.findMany({where:{loanId:id,reversed:false}})
    const issued=await database().$transaction(tx=>issueLeaseRentalInvoice(tx as never,{tenantId:fx.tenantId,rentalId:rental.id,supplyDate:today(),today:today(),createdById:fx.adminA,source:"staff"}))
    expect(issued.kind).toBe("issued")
    const updated=await database().leaseRental.findUniqueOrThrow({where:{id:rental.id},include:{schedule:true,taxInvoice:true}})
    expect(updated.totalCents).toBe(rental.totalCents)
    expect(updated.schedule.totalDue).toBe(updated.taxInvoice?.totalInclVatCents)
    const after=await database().loan.findUniqueOrThrow({where:{id},include:{repaymentSchedule:{orderBy:{installmentNo:"asc"}},payments:true}})
    expect(after.principal).toBe(old.principal-delta)
    expect(after.totalRepayable).toBe(old.totalRepayable-delta)
    expect(after.repaymentSchedule.every(row=>row.totalPaid<=row.totalDue)).toBe(true)
    expect(after.payments.filter(p=>!p.reversed).reduce((sum,p)=>sum+p.amount,0)).toBe(cash)
    const allocated=after.payments.filter(p=>!p.reversed&&p.allocationStatus==="ALLOCATED").reduce((sum,p)=>sum+p.amount,0)
    const excess=after.payments.filter(p=>!p.reversed&&p.allocationStatus==="UNAPPLIED").reduce((sum,p)=>sum+p.amount,0)
    expect(after.totalPaid).toBe(Math.min(cash,after.totalRepayable))
    expect(allocated+excess).toBe(cash)
    expect(after.payments.every(payment=>cashHistory.some(original=>original.receivedAt.getTime()===payment.receivedAt.getTime()&&original.paymentMethod===payment.paymentMethod))).toBe(true)
    expect(after.outstandingPrincipal).toBe(after.totalRepayable-after.totalPaid)
    expect(excess).toBe(full&&delta>0?delta:0)
    for(const row of after.repaymentSchedule){
      expect(row.status).toBe(row.totalPaid>=row.totalDue?"PAID":row.totalPaid>0?"PARTIAL":"PENDING")
      expect(row.paidAt!==null).toBe(row.totalPaid>=row.totalDue)
    }
    if(!full&&delta>0){
      expect(after.repaymentSchedule[1].totalPaid).toBe(delta)
      expect((await database().leaseRental.findFirstOrThrow({where:{loanId:id,periodNo:2}})).taxInvoiceId).not.toBeNull()
    }
    expect(after.status).toBe(full&&delta>0?"COMPLETED":"ACTIVE")
    expect(after.closedAt!==null).toBe(after.status==="COMPLETED")
    expect((await database().$transaction(tx=>issueLeaseRentalInvoice(tx as never,{tenantId:fx.tenantId,rentalId:rental.id,supplyDate:today(),today:today(),createdById:fx.adminA,source:"staff"}))).kind).toBe("already_invoiced")
    expect(await database().payment.count({where:{loanId:id}})).toBe(after.payments.length)
  },120000)
})
