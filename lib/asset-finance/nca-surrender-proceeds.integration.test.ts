import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { runWithTenant } from "@/lib/tenant-scope"
import { loadChargesReplay } from "@/lib/loan/charges-replay"
import { currentSettlementAmount } from "@/lib/loan/settlement"
import { creditSurrenderProceeds } from "./surrender-store"
import { createRecoveryFixture, cleanupRecoveryFixture, newLoan, newSurrender, newValuation, day, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const run=process.env.RUN_ASSET_FINANCE_RECOVERY_IT==="1"
const suite=run?describe:describe.skip
const db=run?new PrismaClient():null
const database=()=>{if(!db)throw new Error("integration database required");return db}
const token=randomUUID().replaceAll("-","").slice(0,16)
let fx:RecoveryFixture
suite("NCA asset settlement and standalone surrender proceeds",()=>{
 beforeAll(async()=>{fx=await createRecoveryFixture(database(),token)},180_000)
 afterAll(async()=>{await cleanupRecoveryFixture(database(),recoveryFixtureTenantId(token));await database().$disconnect()},60_000)
 it.each(["INSTALMENT_SALE","FINANCE_LEASE"] as const)("rebates %s unearned interest through the real receipt path and freezes the shortfall",async(contractType)=>{
  const loan=await newLoan(database(),fx,"NCA",contractType)
  const id=await newSurrender(database(),fx,loan)
  const valuationId=await newValuation(database(),fx,loan.assetId,300_000,"ASSESSOR",day(-29))
  await testSetup(database(),
   [`UPDATE "Loan" SET "principal"=300000,"totalInterest"=15000,"totalRepayable"=315000,"outstandingPrincipal"=300000,"interestModel"='FLAT',"interestRatePm"=0.01,"startDate"=$2::date,"maturityDate"=$3::date WHERE "id"=$1`,loan.loanId,day(-40),day(40)],
   [`UPDATE "SurrenderRequest" SET "requestedOn"=$2::date,"valuationDueOn"=$3::date,"status"='VALUATION_NOTICE_ISSUED',"valuationId"=$4,"valuationNoticePath"='/synthetic/v.pdf',"valuationNoticeSha256"=$5,"valuationNoticeIssuedOn"=$6::date,"valuationNoticeReceivedOn"=$6::date,"valuationReceiptReference"='Synthetic delivery proof' WHERE "id"=$1`,id,day(-30),day(-16),valuationId,"a".repeat(64),day(-29)]
  )
  await database().repaymentSchedule.createMany({data:[10,40].map((offset,i)=>({tenantId:fx.tenantId,loanId:loan.loanId,installmentNo:i+1,dueDate:new Date(`${day(offset)}T10:00:00Z`),principalDue:150000,interestDue:7500,feesDue:0,totalDue:157500}))})
  const before=await database().loan.findUniqueOrThrow({where:{id:loan.loanId},include:{repaymentSchedule:true}})
  const settlement=currentSettlementAmount({loan:before,schedule:before.repaymentSchedule,asOf:new Date()})
  expect(settlement).toBeLessThan(315000)
  const result=await runWithTenant(fx.tenantId,()=>creditSurrenderProceeds({tenantId:fx.tenantId,userId:fx.officer},id,100000))
  expect(result).toMatchObject({kind:"done"})
  const request=await database().surrenderRequest.findUniqueOrThrow({where:{id}})
  expect(request).toMatchObject({status:"PROCEEDS_CREDITED",shortfallCents:settlement-100000,chargesFrozenUntil:null})
  expect(request.chargesFrozenFrom).not.toBeNull()
  expect(await database().payment.count({where:{loanId:loan.loanId,reversed:false}})).toBe(1)
  // Replaying a refused second credit must not create another receipt.
  expect(await runWithTenant(fx.tenantId,()=>creditSurrenderProceeds({tenantId:fx.tenantId,userId:fx.officer},id,100000))).toMatchObject({kind:"not_ready"})
  expect(await database().payment.count({where:{loanId:loan.loanId,reversed:false}})).toBe(1)
  // Exercise the real DB loader past maturity: a standalone surrender must
  // suppress every default-interest day while its statutory freeze is open.
  const replayDate=new Date(`${day(60)}T10:00:00Z`)
  const replayOptions={preview:{startedAt:new Date(`${day(-45)}T10:00:00Z`),letterCents:0}}
  const paused=await loadChargesReplay(database() as unknown as Parameters<typeof loadChargesReplay>[0],{tenantId:fx.tenantId,loanId:loan.loanId},replayDate,replayOptions)
  expect(paused?.result.interestAccrued).toBe(0)
  // Mutation control: remove only the stored surrender pause, with all money,
  // schedules and receipt history unchanged; charges must then accrue.
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "chargesFrozenFrom"=NULL WHERE "id"=$1`,id])
  const unpaused=await loadChargesReplay(database() as unknown as Parameters<typeof loadChargesReplay>[0],{tenantId:fx.tenantId,loanId:loan.loanId},replayDate,replayOptions)
  expect(unpaused!.result.interestAccrued).toBeGreaterThan(0)
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "chargesFrozenFrom"=$2::date WHERE "id"=$1`,id,request.chargesFrozenFrom])
  await applyManualReceipt(database() as unknown as PaymentDb,{tenantId:fx.tenantId,loanId:loan.loanId,amount:settlement-100000,capturedById:fx.officer,paymentMethod:"EFT",reference:"SYNTHETIC-S125-SETTLEMENT"})
  const completed=await database().loan.findUniqueOrThrow({where:{id:loan.loanId}})
  expect(completed).toMatchObject({status:"COMPLETED",totalRepayable:settlement,contractualTotalRepayable:315000})
 })
})
