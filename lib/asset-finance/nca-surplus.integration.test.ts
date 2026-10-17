import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createRecoveryFixture, cleanupRecoveryFixture, newLoan, newSurrender, newRecovery, day, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { approveSurplusAccount, recordSurplusAccount } from "./nca-surplus-account"
import { recordSurplusExecution } from "./nca-surplus-execution"
import { settleOutcome } from "./recovery-freeze"
import { issueNcaSurplusRemittance } from "./nca-surplus"
import { rules } from "./recovery-rules.integration-fixture"
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const run = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = run ? describe : describe.skip
const db = run ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("integration database required"); return db }
const token = randomUUID().replaceAll("-", "").slice(0,16)
let fx: RecoveryFixture
let otherFx: RecoveryFixture
suite("NCA final-notice surplus remittance (real Postgres)", () => {
 beforeAll(async () => { fx = await createRecoveryFixture(database(), token); otherFx = await createRecoveryFixture(database(), `${token}other`) },180_000)
 afterAll(async () => { await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(`${token}other`)); await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(token)); await database().$disconnect() },60_000)
 async function outcome() {
  const loan = await newLoan(database(), fx, "NCA")
  const id = await newSurrender(database(), fx, loan)
  await testSetup(database(), [`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`,loan.loanId], [`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"refundCents"=12345,"shortfallCents"=0 WHERE "id"=$1`,id])
  return { loanId: loan.loanId, surrenderId: id, amountCents:12345 }
 }
 async function readyInstruction() {
  const input=await outcome()
  const actor={tenantId:fx.tenantId,userId:fx.officer}
  await recordSurplusAccount(actor,input.loanId,{bank:{accountHolder:"TEST Consumer",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001",accountType:null},upload:{file:new File(["%PDF-1.4 synthetic bank"],"bank.pdf",{type:"application/pdf"}),docType:"BANK_STATEMENT",dealId:null}})
  await approveSurplusAccount({...actor,userId:fx.adminA},input.loanId,"approve")
  await approveSurplusAccount({...actor,userId:fx.adminB},input.loanId,"authorise")
  const row=await database().$transaction(tx=>issueNcaSurplusRemittance(tx as never,actor,input))
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "status"='FINAL_NOTICE_ISSUED',"finalNoticePath"='/synthetic/final.pdf',"finalNoticeSha256"=$2 WHERE "id"=$1`,input.surrenderId,"a".repeat(64)])
  const loan=await database().loan.findUniqueOrThrow({where:{id:input.loanId}})
  const document=await database().entityDocument.create({data:{tenantId:fx.tenantId,clientId:loan.clientId,entityId:loan.entityId,docType:"OTHER",fileName:"execution.pdf",mimeType:"application/pdf",fileSize:123,storagePath:"/synthetic/execution.pdf",contentSha256:"b".repeat(64),uploadedByType:"staff",uploadedById:fx.officer}})
  const execution={executedOn:new Date(`${day(0)}T00:00:00Z`),bankExecutionReference:"TEST-EXECUTION-123",executionEvidenceDocumentId:document.id,executedById:fx.officer,executionRecordedAt:new Date()}
  return {input,actor,row:row!,document,execution}
 }
 it("guards future bank dates with an executable mutation control",async()=>{
  const {row,execution}=await readyInstruction()
  await rules(database).refuses({table:"NcaSurplusRemittance",trigger:"NcaSurplusRemittance_guard"},/valid bank date/,(tx)=>tx.ncaSurplusRemittance.update({where:{id:row.id},data:{...execution,executedOn:new Date(`${day(1)}T00:00:00Z`)}}))
 })
 it("requires borrower-owned hash-bound bank evidence; removing the guard admits another borrower's document",async()=>{
  const {row,execution,document}=await readyInstruction()
  // Fixture uses the same borrower by default: create a distinct synthetic client for the adversarial proof.
  const client=await database().client.create({data:{tenantId:fx.tenantId,firstName:"TEST",lastName:"Other Consumer",idNumber:`TEST-${randomUUID()}`,email:`test-${randomUUID()}@example.invalid`,phone:"0000000000"}})
  await testSetup(database(),[`UPDATE "EntityDocument" SET "clientId"=$2,"entityId"=NULL WHERE "id"=$1`,document.id,client.id])
  await rules(database).refuses({table:"NcaSurplusRemittance",trigger:"NcaSurplusRemittance_guard"},/borrower-owned/,(tx)=>tx.ncaSurplusRemittance.update({where:{id:row.id},data:execution}))
 })
 it("refuses bank execution before an issued final notice",async()=>{
  const {row,execution,input}=await readyInstruction()
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"finalNoticePath"=NULL,"finalNoticeSha256"=NULL WHERE "id"=$1`,input.surrenderId])
  await rules(database).refuses({table:"NcaSurplusRemittance",trigger:"NcaSurplusRemittance_guard"},/final notice/,(tx)=>tx.ncaSurplusRemittance.update({where:{id:row.id},data:execution}))
 })
 it("retains execution evidence and records it only once",async()=>{
  const {row,execution,document}=await readyInstruction()
  await database().ncaSurplusRemittance.update({where:{id:row.id},data:execution})
  await rules(database).refuses({table:"NcaSurplusRemittance",trigger:"NcaSurplusRemittance_guard"},/once/,(tx)=>tx.ncaSurplusRemittance.update({where:{id:row.id},data:{bankExecutionReference:"TEST-REPLACED"}}))
  await rules(database).refuses({table:"EntityDocument",trigger:"EntityDocument_surplus_evidence"},/retained unchanged/,(tx)=>tx.entityDocument.update({where:{id:document.id},data:{deletedAt:new Date()}}))
 })
 it("enforces same-tenant execution actor with a database foreign key mutation",async()=>{
  const {row,execution}=await readyInstruction()
  await rules(database).refuses({table:"NcaSurplusRemittance",constraint:"NcaSurplusRemittance_executed_by_fkey"},/foreign key/,async(tx)=>{ await tx.$executeRawUnsafe('ALTER TABLE "NcaSurplusRemittance" DISABLE TRIGGER "NcaSurplusRemittance_guard"'); return tx.ncaSurplusRemittance.update({where:{id:row.id},data:{...execution,executedById:otherFx.officer}}) })
 })
 it("refuses cross-tenant execution without retaining any proof or audit",async()=>{
  const {input,row}=await readyInstruction()
  const before=await database().entityDocument.count({where:{tenantId:otherFx.tenantId}})
  const result=await recordSurplusExecution({tenantId:otherFx.tenantId,userId:otherFx.officer},input.loanId,row.id,{executedOn:day(0),bankReference:"TEST-CROSS-TENANT",amountCents:12345,upload:{file:new File(["%PDF-1.4 synthetic proof"],"proof.pdf",{type:"application/pdf"}),docType:"OTHER",dealId:null}})
  expect(result).toMatchObject({kind:"not_found"})
  expect(await database().entityDocument.count({where:{tenantId:otherFx.tenantId}})).toBe(before)
  expect(await database().auditLog.count({where:{tenantId:otherFx.tenantId,action:"ASSET_SURPLUS_EXECUTION_RECORDED"}})).toBe(0)
 })
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
  expect(await database().auditLog.count({where:{entityId:held!.id,action:"ASSET_SURPLUS_INSTRUCTION_ISSUED"}})).toBe(1)
  await rules(database).refuses({table:"NcaSurplusRemittance",trigger:"NcaSurplusRemittance_guard"},/once/,(tx)=>tx.ncaSurplusRemittance.update({where:{id:held!.id},data:{amountCents:12346}}))
 })
 it("keeps an instructed linked surplus outstanding until bank execution is evidenced",async()=>{
  const loan=await newLoan(database(),fx,"NCA")
  const surrenderId=await newSurrender(database(),fx,loan)
  const recoveryId=await newRecovery(database(),fx,loan,"NCA_S127_SURRENDER",{surrenderRequestId:surrenderId})
  await testSetup(database(),[`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`,loan.loanId],[`UPDATE "SurrenderRequest" SET "status"='PROCEEDS_CREDITED',"refundCents"=12345,"shortfallCents"=0 WHERE "id"=$1`,surrenderId])
  const actor={tenantId:fx.tenantId,userId:fx.officer}
  await recordSurplusAccount(actor,loan.loanId,{bank:{accountHolder:"TEST Consumer",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001",accountType:null},upload:{file:new File(["synthetic bank proof"],"bank.pdf",{type:"application/pdf"}),docType:"BANK_STATEMENT",dealId:null}})
  await approveSurplusAccount({...actor,userId:fx.adminA},loan.loanId,"approve")
  await approveSurplusAccount({...actor,userId:fx.adminB},loan.loanId,"authorise")
  const instruction = await database().$transaction(tx=>issueNcaSurplusRemittance(tx as never,actor,{loanId:loan.loanId,surrenderId,amountCents:12345}))
  await testSetup(database(),[`UPDATE "SurrenderRequest" SET "status"='FINAL_NOTICE_ISSUED',"finalNoticePath"='/synthetic/final.pdf',"finalNoticeSha256"=$2 WHERE "id"=$1`,surrenderId,"a".repeat(64)],[`UPDATE "Recovery" SET "status"='FINAL_NOTICE_ISSUED',"settlementDueCents"=300000,"grossProceedsCents"=312345,"deductedCostsCents"=0,"chargedCostsCents"=0,"netProceedsCents"=312345,"shortfallCents"=0,"surplusCents"=12345,"unrecoverableCostsCents"=0,"chargesFrozenFrom"=CURRENT_DATE,"chargesFrozenUntil"=$2::date WHERE "id"=$1`,recoveryId,day(15)])
  expect(await settleOutcome(actor,recoveryId)).toMatchObject({kind:"done",status:"SURPLUS_HELD"})
  await rules(database).refuses({table:"Recovery",trigger:"Recovery_guard"},/surplus closes/,(tx)=>tx.recovery.update({where:{id:recoveryId},data:{status:"CLOSED",closedAt:new Date()}}))
  const input={executedOn:day(0),bankReference:"TEST-EXECUTED-0001",amountCents:12345,upload:{file:new File(["%PDF-1.4 synthetic bank execution"],"execution.pdf",{type:"application/pdf"}),docType:"OTHER" as const,dealId:null}}
  expect(await recordSurplusExecution(actor,loan.loanId,instruction!.id,{...input,amountCents:1})).toMatchObject({kind:"not_ready"})
  const documentsBefore=await database().entityDocument.count({where:{tenantId:fx.tenantId}})
  expect(await recordSurplusExecution(actor,loan.loanId,instruction!.id,input)).toMatchObject({kind:"done"})
  expect(await database().recovery.findUniqueOrThrow({where:{id:recoveryId}})).toMatchObject({status:"CLOSED"})
  expect(await database().auditLog.findFirst({where:{entityId:recoveryId,action:"ASSET_RECOVERY_CLOSED"}})).toMatchObject({newValue:{reason:"Surplus bank execution evidenced"}})
  const executed=await database().ncaSurplusRemittance.findUniqueOrThrow({where:{id:instruction!.id}})
  expect(executed).toMatchObject({bankExecutionReference:input.bankReference,executedById:fx.officer})
  expect(executed.executionEvidenceDocumentId).toBeTruthy()
  expect(await recordSurplusExecution(actor,loan.loanId,instruction!.id,input)).toMatchObject({kind:"not_ready"})
  expect(await database().entityDocument.count({where:{tenantId:fx.tenantId}})).toBe(documentsBefore+1)
  expect(await database().payment.count({where:{loanId:loan.loanId}})).toBe(0)
  expect(await database().auditLog.count({where:{entityId:instruction!.id,action:"ASSET_SURPLUS_EXECUTION_RECORDED"}})).toBe(1)

 })

})
