/** Local synthetic acceptance seed; invoked explicitly, never a shared database. */
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { runWithTenant } from "@/lib/tenant-scope"
import { approveLease, createLeaseFixture, leaseBody, payoutAndBook, signLease } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { backdateLease, payAllOwed } from "./lease-servicing.integration-fixture"
import { recordLeaseTotalLoss } from "./lease-total-loss"
import { createRecoveryTx } from "./recovery-create"
import { recordRecoveryValuation, listForSale } from "./recovery-store"
import { recordDecidedCost } from "./recovery-path.integration-fixture"
import { saleBody, saleRoutes, readJson } from "./recovery-sale.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const seed = process.env.LEASE_FINAL_BROWSER_SEED === "1" ? it : it.skip
seed("seeds synthetic final browser boundaries on owned disposable PG", async () => {
 const db = new PrismaClient()
 try {
  process.env.TRUSTED_PROXY = "1"
  const token = `finalbrowser${randomUUID().replaceAll("-", "").slice(0,8)}`
  const fx = await createLeaseFixture(db, token)
  const setSession = (user: SessionUser | null) => { session.current = user && { user } }
  const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, role, email: `${id}@synthetic.invalid`, tenantId: fx.tenantId })
  const today = sastCalendarDate(new Date()), actor = { tenantId: fx.tenantId, userId: fx.adminA }
  const loans: Record<string,string> = {}
  for (const [index,label] of ["loss","consumer","lessor"].entries()) {
   const deal = await approveLease(fx,staff,leaseBody(fx,{ assetId:fx.assets[index], clientId:fx.lessee,contractType:label==="loss"?"FULL_MAINTENANCE_LEASE":"OPERATING_LEASE",rentalTiming:"ARREARS",...(label==="loss"?{maintenanceRiskModel:"LESSEE_SETTLED"}:{}) }))
   await signLease(fx,db,setSession,deal)
   const loanId = await payoutAndBook(fx,db,staff,deal); loans[label]=loanId
   if(label==="loss") {
    await backdateLease(db,loanId,1); await payAllOwed(db,fx,loanId)
    expect(await db.$transaction(tx=>recordLeaseTotalLoss(tx as never,actor,{loanId,today,insuranceProceedsCents:0,evidence:"Synthetic irreparable loss confirmed for final acceptance"}))).toMatchObject({kind:"recorded"})
    await payAllOwed(db,fx,loanId)
   }
   if(label==="lessor") {
    const rec = await db.$transaction(tx=>createRecoveryTx(tx as never,actor,{loanId,route:"NON_NCA_VOLUNTARY",recoveredOn:today,location:"Synthetic acceptance yard",condition:"Synthetic returned plant"}))
    if(rec.kind!=="done") throw Error(JSON.stringify(rec))
    const scoped=<T>(fn:()=>Promise<T>)=>runWithTenant(fx.tenantId,fn)
    expect(await scoped(()=>recordRecoveryValuation({...actor,userId:fx.officer},rec.id,{source:"ASSESSOR",valuedOn:today,valuerName:"Synthetic independent assessor",amountCents:20000}))).toMatchObject({kind:"done"})
    expect(await scoped(()=>listForSale(actor,rec.id))).toMatchObject({kind:"done"})
    await recordDecidedCost(db,fx,rec.id,{type:"STORAGE",treatment:"CHARGE_TO_ACCOUNT",grossCents:40000})
    const recovery=await db.recovery.findUniqueOrThrow({where:{id:rec.id}})
    staff(fx.adminA,"LOAN_ADMIN")
    const proposed=await readJson(await saleRoutes(fx.host).propose(rec.id,saleBody(recovery.valuationId!,20000,{belowValuationReason:"Synthetic evidence supports forced sale"})))
    expect(proposed.status).toBe(201);const saleId=proposed.body.id as string
    if(proposed.body.approvalRequired){staff(fx.adminB,"LOAN_ADMIN");expect((await saleRoutes(fx.host).approveSale(rec.id,saleId)).status).toBe(200)}
    staff(fx.adminA,"LOAN_ADMIN");expect((await saleRoutes(fx.host).completeSale(rec.id,saleId)).status).toBe(200)
    loans.recovery=rec.id
   }
  }
  const password="Synthetic-Final-Acceptance-2026!",secret="JBSWY3DPEHPK3PXP"
  const admin=await db.user.update({where:{id:fx.adminA},data:{password:await bcrypt.hash(password,10),totpEnabled:true,totpSecret:secret},select:{email:true}})
  const config=await db.tenantConfig.findUniqueOrThrow({where:{tenantId:fx.tenantId}})
  expect(config.assetFinanceLegalWordingApproved).toBe(false)
  writeFileSync("/tmp/cf-final-browser.json",JSON.stringify({tenantId:fx.tenantId,slug:`af-deal-${token}`,email:admin.email,password,secret,today,loans}),{mode:0o600})
 } finally {await db.$disconnect()}
},180000)
