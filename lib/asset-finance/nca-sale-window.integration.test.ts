import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createRecoveryFixture, cleanupRecoveryFixture, newLoan, newSurrender, newRecovery, newValuation, day, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { recordValuationReceipt, withdrawSurrender } from "./surrender-lifecycle"
import { rules, raiseOff } from "./recovery-rules.integration-fixture"
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const run = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = run ? describe : describe.skip
const db = run ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("integration database required"); return db }
const token = randomUUID().replaceAll("-", "").slice(0, 16)
const { refuses } = rules(database)
let fx: RecoveryFixture
let recoveryId: string
suite("NCA sale waits for the valuation notice receipt window", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), token)
    const loan = await newLoan(database(), fx, "NCA")
    const surrenderId = await newSurrender(database(), fx, loan)
    recoveryId = await newRecovery(database(), fx, loan, "NCA_S127_SURRENDER", { surrenderRequestId: surrenderId })
    await testSetup(database(), [`UPDATE "Recovery" SET "status"='VALUATION_NOTICE_ISSUED' WHERE "id"=$1`, recoveryId])
  }, 180_000)
  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(token))
    await database().$disconnect()
  }, 60_000)
  it("refuses listing without receipt evidence, and removing that guard admits the attack", async () => {
    await refuses(raiseOff("guardNcaSaleWindow", "NCA sale waits until ten business days after valuation notice receipt"), /ten business days/, (tx) => tx.recovery.update({ where: { id: recoveryId }, data: { status: "LISTED" } }))
  })
  it("admits listing after the whole window has elapsed", async () => {
    const rec = await database().recovery.findUniqueOrThrow({ where: { id: recoveryId } })
    await testSetup(database(), [`UPDATE "SurrenderRequest" SET "valuationNoticeReceivedOn" = CURRENT_DATE - 30 WHERE "id"=$1`, rec.surrenderRequestId])
    expect(await database().recovery.update({ where: { id: recoveryId }, data: { status: "LISTED" } })).toMatchObject({ status: "LISTED" })
  })
  it("records receipt and a timely withdrawal with actual goods-return evidence", async () => {
    const loan = await newLoan(database(), fx, "NCA")
    const id = await newSurrender(database(), fx, loan)
    const valuationId = await newValuation(database(), fx, loan.assetId)
    await database().surrenderRequest.update({ where: { id }, data: { status: "VALUED", valuationId } })
    await database().surrenderRequest.update({ where: { id }, data: { status: "VALUATION_NOTICE_ISSUED", valuationNoticePath: "/synthetic/notice.pdf", valuationNoticeSha256: "a".repeat(64) } })
    const actor = { tenantId: fx.tenantId, userId: fx.officer }
    const receivedOn = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" })
    expect(await recordValuationReceipt(actor, id, "surrender", { receivedOn, reference: "Synthetic delivery proof 123" })).toMatchObject({ kind: "done" })
    expect(await withdrawSurrender(actor, id, "Synthetic signed handover receipt 456")).toMatchObject({ kind: "done" })
    expect(await database().surrenderRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "WITHDRAWN", goodsReturnReference: "Synthetic signed handover receipt 456" })
    expect(await newSurrender(database(), fx, loan)).not.toBe(id)
  })
  it("refuses withdrawal without goods-return evidence, and removing its guard admits it", async () => {
    const loan=await newLoan(database(),fx,"NCA")
    const id=await newSurrender(database(),fx,loan)
    await testSetup(database(), [`UPDATE "SurrenderRequest" SET "status"='VALUATION_NOTICE_ISSUED',"valuationNoticeReceivedOn"=CURRENT_DATE WHERE "id"=$1`,id])
    await refuses({ table:"SurrenderRequest",trigger:"SurrenderRequest_guard" },/return of unsold goods/, (tx)=>tx.surrenderRequest.update({where:{id},data:{status:"WITHDRAWN"}}))
  })
  it("gates the proceeds receipt itself, before any money can be left unlinked", async () => {
    const loan=await newLoan(database(),fx,"NCA")
    const id=await newSurrender(database(),fx,loan)
    await refuses({table:"Payment",trigger:"Payment_surrender_window"},/Surrender proceeds receipt waits/,(tx)=>tx.payment.create({data:{tenantId:fx.tenantId,loanId:loan.loanId,amount:100,capturedBy:fx.officer,idempotencyKey:`asset-surrender:${id}:proceeds`}}))
  })
  it.each([["surrender","VALUATION_NOTICE_ISSUED"],["recovery","VALUATION_NOTICE_ISSUED"],["recovery","LISTED"],["recovery","SOLD"]] as const)("records historic issue evidence for a pre-migration %s %s notice once",async(kind,status)=>{
    const loan=await newLoan(database(),fx,"NCA")
    const surrenderId=await newSurrender(database(),fx,loan)
    const valuationId=await newValuation(database(),fx,loan.assetId)
    await database().surrenderRequest.update({where:{id:surrenderId},data:{status:"VALUED",valuationId}})
    await database().surrenderRequest.update({where:{id:surrenderId},data:{status:"VALUATION_NOTICE_ISSUED",valuationNoticePath:"/synthetic/legacy.pdf",valuationNoticeSha256:"a".repeat(64)}})
    let id=surrenderId
    if(kind==="recovery"){
      id=await newRecovery(database(),fx,loan,"NCA_S127_SURRENDER",{surrenderRequestId:surrenderId})
      await testSetup(database(),[`UPDATE "Recovery" SET "route"='NCA_S131_ATTACHMENT',"surrenderRequestId"=NULL,"status"='VALUATION_NOTICE_ISSUED',"valuationId"=$2,"valuationNoticePath"='/synthetic/legacy.pdf',"valuationNoticeSha256"=$3 WHERE "id"=$1`,id,valuationId,"a".repeat(64)])
    }
    await testSetup(database(),[`UPDATE "${kind==="surrender"?"SurrenderRequest":"Recovery"}" SET "valuationNoticeIssuedOn"=NULL WHERE "id"=$1`,id])
    if(kind==="recovery") await testSetup(database(),[`UPDATE "Recovery" SET "status"=$2::"RecoveryStatus" WHERE "id"=$1`,id,status])
    const input={receivedOn:day(-29),reference:"Synthetic historical notice and delivery evidence",issuedOn:day(-30)}
    expect(await recordValuationReceipt({tenantId:fx.tenantId,userId:fx.officer},id,kind,input)).toMatchObject({kind:"done"})
    expect(await recordValuationReceipt({tenantId:fx.tenantId,userId:fx.officer},id,kind,input)).toMatchObject({kind:"not_ready"})
  })
  it("permits a withdrawn request to be followed by a new surrender on the same loan", async () => {
    const loan = await newLoan(database(), fx, "NCA")
    const id = await newSurrender(database(), fx, loan)
    await testSetup(database(), [`UPDATE "SurrenderRequest" SET "status"='WITHDRAWN' WHERE "id"=$1`, id])
    expect(await newSurrender(database(), fx, loan)).not.toBe(id)
  })
})
