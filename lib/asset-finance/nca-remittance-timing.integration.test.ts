import { determineSurplusRecipient } from "./nca-surplus.integration-fixture"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createRecoveryFixture, cleanupRecoveryFixture, newLoan, newSurrender, newRecovery, courtMatter, day, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { approveSurplusAccount, recordSurplusAccount } from "./nca-surplus-account"
import { issueNcaSurplusRemittance } from "./nca-surplus"
import { rules } from "./recovery-rules.integration-fixture"
import { createRefund } from "./recovery-refund"
import { settleOutcome } from "./recovery-freeze"
import { recordSurplusExecution } from "./nca-surplus-execution"
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const run = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const db = run ? new PrismaClient() : null
const d = () => { if (!db) throw new Error("real PostgreSQL required"); return db }
const token = randomUUID().replaceAll("-", "").slice(0,16)
let fx: RecoveryFixture
;(run ? describe : describe.skip)("ordinary NCA surplus must be remitted before its final notice", () => {
 beforeAll(async () => { fx = await createRecoveryFixture(d(), token) },180000)
 afterAll(async () => { await cleanupRecoveryFixture(d(), recoveryFixtureTenantId(token)); await d().$disconnect() },60000)
 async function prepare(competingAgreement = false) {
  const loan = await newLoan(d(),fx,"NCA"), surrenderId = await newSurrender(d(),fx,loan)
  await testSetup(d(),[`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`,loan.loanId],[`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"refundCents"=12345,"shortfallCents"=0 WHERE "id"=$1`,surrenderId])
  await determineSurplusRecipient(fx, loan.loanId, competingAgreement)
  const actor={tenantId:fx.tenantId,userId:fx.officer}
  await recordSurplusAccount(actor,loan.loanId,{bank:{accountHolder:competingAgreement ? "TEST National Consumer Tribunal" : "TEST Consumer",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001",accountType:null},upload:{file:new File(["%PDF-1.4 synthetic bank"],"bank.pdf",{type:"application/pdf"}),docType:"BANK_STATEMENT",dealId:null}})
  await approveSurplusAccount({...actor,userId:fx.adminA},loan.loanId,"approve")
  await approveSurplusAccount({...actor,userId:fx.adminB},loan.loanId,"authorise")
  const row=await d().$transaction(tx=>issueNcaSurplusRemittance(tx as never,actor,{loanId:loan.loanId,surrenderId,amountCents:12345}))
  return {loanId:loan.loanId,surrenderId,actor,row:row!}
 }
 it("refuses a final notice backed only by an unexecuted ordinary instruction",async()=>{
  const {surrenderId}=await prepare()
  await rules(d).refuses({table:"SurrenderRequest",trigger:"SurrenderRequest_final_remittance"},/remit|execut/i,async tx=>{
   await tx.$executeRawUnsafe('ALTER TABLE "SurrenderRequest" DISABLE TRIGGER "SurrenderRequest_guard"')
   await tx.$executeRawUnsafe('ALTER TABLE "SurrenderRequest" DISABLE TRIGGER "SurrenderRequest_sale_window"')
   await tx.surrenderRequest.update({where:{id:surrenderId},data:{status:"FINAL_NOTICE_ISSUED",finalNoticePath:"/synthetic/final.pdf",finalNoticeSha256:"a".repeat(64)}})
   await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  })
 })
 it("accepts exact actual bank execution while the notice is still pending",async()=>{
  const {loanId,actor,row}=await prepare()
  expect(await recordSurplusExecution(actor,loanId,row.id,{executedOn:day(0),bankReference:`TEST-PRE-NOTICE-${randomUUID()}`,amountCents:12345,destinationAccountId:row!.accountId!,destinationConfirmed:true,upload:{file:new File(["%PDF-1.4 synthetic executed bank payment"],"execution.pdf",{type:"application/pdf"}),docType:"OTHER",dealId:null}})).toMatchObject({kind:"done"})
  expect((await d().ncaSurplusRemittance.findUniqueOrThrow({where:{id:row.id}})).executedOn).not.toBeNull()
 })
 it("does not infer no competing credit interest from missing data",async()=>{
  const loan=await newLoan(d(),fx,"NCA"), surrenderId=await newSurrender(d(),fx,loan)
  await testSetup(d(),[`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`,loan.loanId],[`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"refundCents"=12345,"shortfallCents"=0 WHERE "id"=$1`,surrenderId])
  await expect(d().$transaction(tx=>issueNcaSurplusRemittance(tx as never,{tenantId:fx.tenantId,userId:fx.officer},{loanId:loan.loanId,surrenderId,amountCents:12345}))).rejects.toThrow(/unknown|determine/i)
  await rules(d).refuses({table:"NcaSurplusRemittance",trigger:"NcaSurplusRemittance_recipient_guard"},/unknown is not no/,(tx)=>tx.ncaSurplusRemittance.create({data:{tenantId:fx.tenantId,surrenderId,amountCents:12345,status:"HELD_NO_VERIFIED_ACCOUNT",exceptionReason:"TEST no account confirmed",issuedById:fx.officer}}))
 })
 it("routes another registered credit provider's evidenced interest to the Tribunal, never the consumer",async()=>{
  const {loanId,row}=await prepare(true)
  const account=await d().ncaSurplusAccount.findUniqueOrThrow({where:{id:row.accountId!}})
  expect(account.recipient).toBe("TRIBUNAL")
  const assessment=await d().ncaSurplusDetermination.findFirstOrThrow({where:{loanId}})
  await rules(d).refuses({table:"NcaSurplusAccount",trigger:"NcaSurplusAccount_recipient_guard"},/Tribunal remittance/,async tx=>{
   await tx.$executeRawUnsafe('ALTER TABLE "NcaSurplusAccount" DISABLE TRIGGER "NcaSurplusAccount_guard"')
   return tx.ncaSurplusAccount.update({where:{id:account.id},data:{recipient:"CONSUMER"}})
  })
  await rules(d).refuses({table:"NcaSurplusDetermination",trigger:"NcaSurplusDetermination_guard"},/retained unchanged/,(tx)=>tx.ncaSurplusDetermination.update({where:{id:assessment.id},data:{competingAgreement:false}}))
  await rules(d).refuses({table:"EntityDocument",trigger:"EntityDocument_surplus_determination"},/retained unchanged/,(tx)=>tx.entityDocument.update({where:{id:assessment.evidenceDocumentId},data:{deletedAt:new Date()}}))
 })

 it.each(["s127", "s131"])("retains %s held statement, keeps payable open and confirms later actual remittance",async route=>{
  const loan=await newLoan(d(),fx,"NCA")
  const surrenderId=route==="s127" ? await newSurrender(d(),fx,loan) : undefined
  const recoveryId=await newRecovery(d(),fx,loan,route==="s127" ? "NCA_S127_SURRENDER" : "NCA_S131_ATTACHMENT",surrenderId ? {surrenderRequestId:surrenderId} : {legalMatterId:await courtMatter(d(),fx,loan)})
  await determineSurplusRecipient(fx,loan.loanId)
  await testSetup(d(),[`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`,loan.loanId],...(surrenderId ? [[`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"refundCents"=12345,"shortfallCents"=0 WHERE "id"=$1`,surrenderId] as [string,string]] : []),[`UPDATE "Recovery" SET "status"='PROCEEDS_APPLIED',"settlementDueCents"=300000,"grossProceedsCents"=312345,"deductedCostsCents"=0,"chargedCostsCents"=0,"netProceedsCents"=312345,"shortfallCents"=0,"surplusCents"=12345,"unrecoverableCostsCents"=0 WHERE "id"=$1`,recoveryId])
  const actor={tenantId:fx.tenantId,userId:fx.officer}
  const row=await d().$transaction(tx=>issueNcaSurplusRemittance(tx as never,actor,{loanId:loan.loanId,surrenderId,recoveryId:surrenderId ? undefined : recoveryId,amountCents:12345},true))
  expect(row!.status).toBe("HELD_NO_VERIFIED_ACCOUNT")
  await testSetup(d(),...(surrenderId ? [[`UPDATE "SurrenderRequest" SET "status"='FINAL_NOTICE_ISSUED',"finalNoticePath"='/synthetic/held-original.pdf',"finalNoticeSha256"=$2 WHERE "id"=$1`,surrenderId,"a".repeat(64)] as [string,string,string]] : []),[`UPDATE "Recovery" SET "status"='FINAL_NOTICE_ISSUED',"finalNoticePath"=CASE WHEN "route"='NCA_S131_ATTACHMENT' THEN '/synthetic/held-original.pdf' ELSE NULL END,"finalNoticeSha256"=CASE WHEN "route"='NCA_S131_ATTACHMENT' THEN $2 ELSE NULL END,"chargesFrozenFrom"=CURRENT_DATE,"chargesFrozenUntil"=$3::date WHERE "id"=$1`,recoveryId,"a".repeat(64),day(15)])
  expect(await settleOutcome(actor,recoveryId)).toMatchObject({kind:"done",status:"SURPLUS_HELD"})
  const bank = {accountHolder:"TEST Consumer",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001",accountType:null}
  expect(await createRefund(actor,recoveryId,{bank,upload:{file:new File(["%PDF-1.4 legacy bypass bank evidence"],"bank.pdf",{type:"application/pdf"}),docType:"BANK_STATEMENT",dealId:null}})).toMatchObject({kind:"not_ready"})
  const determination = await d().ncaSurplusDetermination.findFirstOrThrow({where:{tenantId:fx.tenantId,loanId:loan.loanId}})
  await rules(d).refuses({table:"RecoveryRefund",trigger:"RecoveryRefund_no_duplicate_nca"},/recorded instruction or held-account exception/,tx=>tx.recoveryRefund.create({data:{tenantId:fx.tenantId,recoveryId,amountCents:12345,accountHolder:bank.accountHolder,bankName:bank.bankName,branchCode:bank.branchCode,accountNumber:bank.accountNumber,bankVerifiedById:fx.officer,bankVerificationDocumentId:determination.evidenceDocumentId,createdById:fx.officer}}))

  await rules(d).refuses({table:"Recovery",trigger:"Recovery_actual_surplus_remittance"},/actual evidenced remittance/,async tx=>{
    await tx.$executeRawUnsafe('ALTER TABLE "Recovery" DISABLE TRIGGER "Recovery_guard"')
    return tx.recovery.update({where:{id:recoveryId},data:{status:"CLOSED",closedAt:new Date()}})
  })
  await recordSurplusAccount(actor,loan.loanId,{bank:{accountHolder:"TEST Consumer",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001",accountType:null},upload:{file:new File(["%PDF-1.4 synthetic later bank proof"],"bank.pdf",{type:"application/pdf"}),docType:"BANK_STATEMENT",dealId:null}})
  expect(await approveSurplusAccount({...actor,userId:fx.adminA},loan.loanId,"approve")).toMatchObject({kind:"done"})
  expect(await approveSurplusAccount({...actor,userId:fx.adminB},loan.loanId,"authorise")).toMatchObject({kind:"done"})
  const released = await d().ncaSurplusRemittance.findUniqueOrThrow({where:{id:row!.id}})
  expect(await recordSurplusExecution(actor,loan.loanId,row!.id,{executedOn:day(0),bankReference:`TEST-HELD-${route}-${randomUUID()}`,amountCents:12345,destinationAccountId:released.accountId!,destinationConfirmed:true,upload:{file:new File(["%PDF-1.4 synthetic later actual remittance"],"execution.pdf",{type:"application/pdf"}),docType:"OTHER",dealId:null}})).toMatchObject({kind:"done"})
  expect(await d().recovery.findUniqueOrThrow({where:{id:recoveryId}})).toMatchObject({status:"CLOSED",finalNoticePath:route === "s131" ? "/synthetic/held-original.pdf" : null,finalNoticeSha256:route === "s131" ? "a".repeat(64) : null})
  expect(await d().ncaSurplusRemittance.findUniqueOrThrow({where:{id:row!.id}})).toMatchObject({status:"INSTRUCTED",exceptionReason:row!.exceptionReason})
  expect(await d().payment.count({where:{loanId:loan.loanId}})).toBe(0)
 })

 it("a prepared held instruction cannot bypass a now-verified account, but can release/pay before first finalisation",async()=>{
  const loan=await newLoan(d(),fx,"NCA"),surrenderId=await newSurrender(d(),fx,loan)
  await determineSurplusRecipient(fx,loan.loanId)
  await testSetup(d(),[`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`,loan.loanId],[`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"refundCents"=12345,"shortfallCents"=0 WHERE "id"=$1`,surrenderId])
  const actor={tenantId:fx.tenantId,userId:fx.officer},input={loanId:loan.loanId,surrenderId,amountCents:12345}
  const row=await d().$transaction(tx=>issueNcaSurplusRemittance(tx as never,actor,input))
  await recordSurplusAccount(actor,loan.loanId,{bank:{accountHolder:"TEST Consumer",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001",accountType:null},upload:{file:new File(["%PDF-1.4 TEST bank proof"],"bank.pdf",{type:"application/pdf"}),docType:"BANK_STATEMENT",dealId:null}})
  await approveSurplusAccount({...actor,userId:fx.adminA},loan.loanId,"approve")
  await expect(d().$transaction(tx=>issueNcaSurplusRemittance(tx as never,actor,input,true))).rejects.toThrow(/verified|actual|execution/i)
  await rules(d).refuses({table:"SurrenderRequest",trigger:"SurrenderRequest_final_remittance"},/verified|actual|executed/i,async tx=>{
    await tx.$executeRawUnsafe('ALTER TABLE "SurrenderRequest" DISABLE TRIGGER "SurrenderRequest_guard"')
    await tx.$executeRawUnsafe('ALTER TABLE "SurrenderRequest" DISABLE TRIGGER "SurrenderRequest_sale_window"')
    await tx.surrenderRequest.update({where:{id:surrenderId},data:{status:"FINAL_NOTICE_ISSUED",finalNoticePath:"/synthetic/final.pdf",finalNoticeSha256:"a".repeat(64)}})
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  })
  expect(await approveSurplusAccount({...actor,userId:fx.adminB},loan.loanId,"authorise")).toMatchObject({kind:"done"})
  const released=await d().ncaSurplusRemittance.findUniqueOrThrow({where:{id:row!.id}})
  expect(released.exceptionReason).toBe(row!.exceptionReason)
  expect(await recordSurplusExecution(actor,loan.loanId,row!.id,{executedOn:day(0),bankReference:`TEST-PREPARED-HELD-${randomUUID()}`,amountCents:12345,destinationAccountId:released.accountId!,destinationConfirmed:true,upload:{file:new File(["%PDF-1.4 TEST actual execution"],"execution.pdf",{type:"application/pdf"}),docType:"OTHER",dealId:null}})).toMatchObject({kind:"done"})
  expect(await d().$transaction(tx=>issueNcaSurplusRemittance(tx as never,actor,input,true))).toMatchObject({id:row!.id})
 })

})
