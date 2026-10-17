import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createRecoveryFixture, cleanupRecoveryFixture, newLoan, newSurrender, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { approveSurplusAccount, recordSurplusAccount } from "./nca-surplus-account"
import { issueNcaSurplusRemittance } from "./nca-surplus"
import { rules } from "./recovery-rules.integration-fixture"
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const run = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = run ? describe : describe.skip
const db = run ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("integration database required"); return db }
const token = randomUUID().replaceAll("-", "").slice(0,16)
let fx: RecoveryFixture
suite("NCA final-notice surplus remittance (real Postgres)", () => {
 beforeAll(async () => { fx = await createRecoveryFixture(database(), token) },180_000)
 afterAll(async () => { await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(token)); await database().$disconnect() },60_000)
 async function outcome() {
  const loan = await newLoan(database(), fx, "NCA")
  const id = await newSurrender(database(), fx, loan)
  await testSetup(database(), [`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`,loan.loanId], [`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"refundCents"=12345,"shortfallCents"=0 WHERE "id"=$1`,id])
  return { loanId: loan.loanId, surrenderId: id, amountCents:12345 }
 }
 it("issues an audited held-for-account exception when no verified account exists", async () => {
  const input = await outcome()
  const result = await database().$transaction((tx) => issueNcaSurplusRemittance(tx as never,{ tenantId:fx.tenantId,userId:fx.officer },input))
  expect(result).toMatchObject({ status:"HELD_NO_VERIFIED_ACCOUNT",amountCents:12345,accountId:null })
  expect(await database().auditLog.count({ where:{ tenantId:fx.tenantId,action:"ASSET_SURPLUS_HELD_EXCEPTION",entityId:result!.id } })).toBe(1)
 })
 it("requires distinct verification and prior release authority, then issues the exact surplus", async () => {
  const input=await outcome()
  const actor={ tenantId:fx.tenantId,userId:fx.officer }
  const prepared=await recordSurplusAccount(actor,input.loanId,{ bank:{ accountHolder:"TEST Consumer",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001",accountType:null }, upload:{ file:new File(["synthetic bank letter"],"bank.pdf",{type:"application/pdf"}),docType:"BANK_STATEMENT", dealId:null } })
  expect(prepared.kind).toBe("done")
  if(prepared.kind!=="done") throw new Error("synthetic bank setup refused")
  await rules(database).refuses({table:"NcaSurplusAccount",trigger:"NcaSurplusAccount_guard"},/separate staff/,(tx)=>tx.ncaSurplusAccount.update({where:{id:prepared.id},data:{approvedById:fx.officer}}))
  expect(await approveSurplusAccount(actor,input.loanId,"approve")).toMatchObject({kind:"not_ready"})
  expect(await approveSurplusAccount({ ...actor,userId:fx.adminA },input.loanId,"approve")).toMatchObject({kind:"done"})
  await expect(database().$transaction((tx)=>issueNcaSurplusRemittance(tx as never,actor,input))).rejects.toThrow(/release/i)
  expect(await approveSurplusAccount({ ...actor,userId:fx.adminA },input.loanId,"authorise")).toMatchObject({kind:"not_ready"})
  expect(await approveSurplusAccount({ ...actor,userId:fx.adminB },input.loanId,"authorise")).toMatchObject({kind:"done"})
  expect(await database().$transaction((tx)=>issueNcaSurplusRemittance(tx as never,actor,input))).toMatchObject({status:"INSTRUCTED",amountCents:12345})
 })
 it("refuses a surplus instruction with a different amount; removing its guard admits the attack", async () => {
  const input=await outcome()
  await rules(database).refuses({table:"NcaSurplusRemittance",trigger:"NcaSurplusRemittance_guard"},/equals the notice surplus/,(tx)=>tx.ncaSurplusRemittance.create({data:{tenantId:fx.tenantId,surrenderId:input.surrenderId,amountCents:1,status:"HELD_NO_VERIFIED_ACCOUNT",exceptionReason:"Synthetic missing account exception",issuedById:fx.officer}}))
 })
 it("refuses final notice without the simultaneous payment instruction or exception; removing the deferred guard admits it", async () => {
  const input=await outcome()
  const { refuses }=rules(database)
  await refuses({ table:"SurrenderRequest",trigger:"SurrenderRequest_final_remittance" },/final notice and surplus/, async(tx)=>{
   await tx.$executeRawUnsafe('ALTER TABLE "SurrenderRequest" DISABLE TRIGGER "SurrenderRequest_guard"')
   await tx.$executeRawUnsafe('ALTER TABLE "SurrenderRequest" DISABLE TRIGGER "SurrenderRequest_sale_window"')
   return tx.surrenderRequest.update({where:{id:input.surrenderId},data:{status:"FINAL_NOTICE_ISSUED",finalNoticePath:"/synthetic/final.pdf",finalNoticeSha256:"a".repeat(64)}})
  })
 })
 it("retains its original exception and issues once after later independent bank authorisation",async()=>{
  const loan=await newLoan(database(),fx,"NCA")
  const id=await newSurrender(database(),fx,loan)
  await testSetup(database(),[`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`,loan.loanId],[`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"refundCents"=12345,"shortfallCents"=0 WHERE "id"=$1`,id])
  const actor={tenantId:fx.tenantId,userId:fx.officer}
  const held=await database().$transaction(tx=>issueNcaSurplusRemittance(tx as never,actor,{loanId:loan.loanId,surrenderId:id,amountCents:12345}))
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "status"='FINAL_NOTICE_ISSUED',"finalNoticePath"='/synthetic/final.pdf',"finalNoticeSha256"=$2 WHERE "id"=$1`,id,"a".repeat(64)])
  expect((await recordSurplusAccount(actor,loan.loanId,{bank:{accountHolder:"TEST Consumer",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001",accountType:null},upload:{file:new File(["synthetic bank proof"],"bank.pdf",{type:"application/pdf"}),docType:"BANK_STATEMENT",dealId:null}})).kind).toBe("done")
  expect((await approveSurplusAccount({...actor,userId:fx.adminA},loan.loanId,"approve")).kind).toBe("done")
  expect((await approveSurplusAccount({...actor,userId:fx.adminB},loan.loanId,"authorise")).kind).toBe("done")
  const released=await database().ncaSurplusRemittance.findUniqueOrThrow({where:{id:held!.id}})
  expect(released).toMatchObject({status:"INSTRUCTED",amountCents:12345,exceptionReason:held!.exceptionReason})
  expect(await database().ncaSurplusRemittance.count({where:{surrenderId:id}})).toBe(1)
  expect((await approveSurplusAccount({...actor,userId:fx.adminB},loan.loanId,"authorise")).kind).toBe("not_ready")
  expect(await database().auditLog.count({where:{entityId:held!.id,action:"ASSET_SURPLUS_REMITTED"}})).toBe(1)
  await rules(database).refuses({table:"NcaSurplusRemittance",trigger:"NcaSurplusRemittance_guard"},/once/,(tx)=>tx.ncaSurplusRemittance.update({where:{id:held!.id},data:{amountCents:12346}}))
 })
})
