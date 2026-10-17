import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createRecoveryFixture, cleanupRecoveryFixture, newLoan, newSurrender, newRecovery, newValuation, day, type RecoveryFixture } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { recordValuationReceipt, withdrawSurrender, requireNcaSaleWindow } from "./surrender-lifecycle"
import { creditSurrenderProceeds } from "./surrender-store"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const run = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const db = run ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("DB required"); return db }
let fx: RecoveryFixture
const token = randomUUID().replaceAll("-", "").slice(0,16)
;(run ? describe : describe.skip)("Independent NCA adversarial checks", () => {
 beforeAll(async () => { fx = await createRecoveryFixture(database(), token) },180000)
 afterAll(async () => { if(fx) await cleanupRecoveryFixture(database(),fx.tenantId); await database().$disconnect() },60000)
 const actor = () => ({tenantId:fx.tenantId,userId:fx.officer})
 async function notice(received = day(0)) {
  const loan = await newLoan(database(),fx,"NCA")
  const id = await newSurrender(database(),fx,loan)
  const valuationId = await newValuation(database(),fx,loan.assetId)
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "status"='VALUATION_NOTICE_ISSUED',"valuationNoticePath"='/synthetic/independent.pdf',"valuationNoticeSha256"=$2,"valuationNoticeIssuedOn"=$3::date,"valuationNoticeReceivedOn"=$4::date,"valuationReceiptReference"='Synthetic delivery receipt',"valuationId"=$5 WHERE "id"=$1`,id,"b".repeat(64),day(-60),received,valuationId])
  return {loan,id}
 }
 it("refuses a foreign tenant at receipt, withdrawal and proceeds boundaries without audit or payment",async()=>{
  const {loan,id}=await notice()
  const foreign={...actor(),tenantId:'synthetic-foreign-tenant'}
  const before=await database().auditLog.count({where:{entityId:id}})
  expect(await recordValuationReceipt(foreign,id,"surrender",{receivedOn:day(0),reference:'Synthetic receipt proof'})).toMatchObject({kind:'not_found'})
  expect(await withdrawSurrender(foreign,id,'Synthetic handover proof')).toMatchObject({kind:'not_found'})
  expect(await creditSurrenderProceeds(foreign,id,123)).toMatchObject({kind:'not_found'})
  expect(await database().auditLog.count({where:{entityId:id}})).toBe(before)
  expect(await database().payment.count({where:{loanId:loan.loanId}})).toBe(0)
 })
 it("rolls back linked recovery withdrawal when the loan remains in default",async()=>{
  const {loan,id}=await notice()
  const recovery=await newRecovery(database(),fx,loan,'NCA_S127_SURRENDER',{surrenderRequestId:id})
  await testSetup(database(),[`UPDATE "Loan" SET "status"='DEFAULTED',"arrearsAmount"=1 WHERE "id"=$1`,loan.loanId])
  expect(await withdrawSurrender(actor(),id,'Synthetic actual handover receipt')).toMatchObject({kind:'not_ready'})
  expect(await database().recovery.findUniqueOrThrow({where:{id:recovery}})).toMatchObject({status:'RECOVERED'})
  expect(await database().surrenderRequest.findUniqueOrThrow({where:{id}})).toMatchObject({status:'VALUATION_NOTICE_ISSUED',goodsReturnedOn:null})
  expect(await database().auditLog.count({where:{entityId:{in:[id,recovery]},action:{in:['ASSET_RECOVERY_WITHDRAWN','ASSET_SURRENDER_WITHDRAWN']}}})).toBe(0)
 })
 it("serializes simultaneous withdrawals to one state change and one audit",async()=>{
  const {id}=await notice()
  const results=await Promise.all([withdrawSurrender(actor(),id,'Synthetic handover receipt A'),withdrawSurrender(actor(),id,'Synthetic handover receipt B')])
  expect(results.map(r=>r.kind).sort()).toEqual(['done','not_ready'])
  expect(await database().auditLog.count({where:{entityId:id,action:'ASSET_SURRENDER_WITHDRAWN'}})).toBe(1)
 })
 it("keeps the entire tenth business day closed and admits the next day across holidays",async()=>{
  const received='2026-12-11'
  const {id}=await notice(received)
  const end=addSouthAfricanBusinessDays(received,10)
  await expect(database().$transaction(tx=>requireNcaSaleWindow(tx,fx.tenantId,id,'surrender',new Date(`${end}T21:59:59Z`)))).rejects.toThrow(/ten business days/)
  await expect(database().$transaction(tx=>requireNcaSaleWindow(tx,fx.tenantId,id,'surrender',new Date(`${end}T22:00:00Z`)))).resolves.toBeUndefined()
 })
 it("refuses future, pre-issue and impossible historical receipt dates without persisting evidence",async()=>{
  const {id}=await notice()
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "valuationNoticeReceivedOn"=NULL,"valuationReceiptReference"=NULL WHERE "id"=$1`,id])
  for(const receivedOn of [day(1),day(-61),'2026-02-30']) {
   expect(await recordValuationReceipt(actor(),id,'surrender',{receivedOn,reference:'Synthetic receipt evidence'})).toMatchObject({kind:'not_ready'})
  }
  expect(await database().surrenderRequest.findUniqueOrThrow({where:{id}})).toMatchObject({valuationNoticeReceivedOn:null})
 })
 it("serializes competing historical receipt attestations to exactly one immutable evidence record",async()=>{
  const {id}=await notice()
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "valuationNoticeReceivedOn"=NULL,"valuationReceiptReference"=NULL,"valuationNoticeIssuedOn"=NULL WHERE "id"=$1`,id])
  const results=await Promise.all([day(-30),day(-29)].map(receivedOn=>recordValuationReceipt(actor(),id,'surrender',{receivedOn,issuedOn:day(-31),reference:'Synthetic independently attested delivery'})))
  expect(results.map(r=>r.kind).sort()).toEqual(['done','not_ready'])
  expect(await database().auditLog.count({where:{entityId:id,action:'ASSET_VALUATION_NOTICE_RECEIPT_RECORDED'}})).toBe(1)
 })
 it("rejects an inside-window proceeds attempt without leaving a receipt or audit",async()=>{
  const {loan,id}=await notice()
  expect(await creditSurrenderProceeds(actor(),id,1000)).toMatchObject({kind:'not_ready'})
  expect(await database().payment.count({where:{loanId:loan.loanId}})).toBe(0)
  expect(await database().auditLog.count({where:{entityId:id,action:'ASSET_SURRENDER_PROCEEDS_CREDITED'}})).toBe(0)
 })
})
