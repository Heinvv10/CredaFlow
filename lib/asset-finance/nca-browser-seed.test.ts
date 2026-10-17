// Optional synthetic browser fixture. Never runs in unit/CI gates.
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { it, vi } from "vitest"
import { createRecoveryFixture, newLoan, day } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const seed = process.env.NCA_LEGAL_BROWSER_SEED === "1" ? it : it.skip
seed("seeds only the owned disposable local acceptance database", async () => {
 const db=new PrismaClient()
 try {
  const token=`nca_browser_${randomUUID().replaceAll("-","").slice(0,8)}`
  const fx=await createRecoveryFixture(db,token)
  const password="Synthetic-Nca-Acceptance-2026!"
  const secret="JBSWY3DPEHPK3PXP"
  const staff=[]
  for(const id of [fx.officer,fx.adminA,fx.adminB]) {
   const row=await db.user.update({where:{id},data:{password:await bcrypt.hash(password,10),totpEnabled:true,totpSecret:secret},select:{id:true,email:true,role:true}})
   staff.push(row)
  }
  const loans=[]
  for(const label of ["SURRENDER","SETTLEMENT"]) {
   const loan=await newLoan(db,fx,"NCA","INSTALMENT_SALE")
   await testSetup(db,[`UPDATE "Loan" SET "reference"=$2,"principal"=300000,"totalInterest"=15000,"totalRepayable"=315000,"outstandingPrincipal"=300000,"interestModel"='FLAT',"interestRatePm"=0.01,"startDate"=$3::date,"maturityDate"=$4::date WHERE "id"=$1`,loan.loanId,`SYNTHETIC-NCA-${label}`,day(-40),day(40)])
   await db.repaymentSchedule.createMany({data:[10,40].map((offset,i)=>({tenantId:fx.tenantId,loanId:loan.loanId,installmentNo:i+1,dueDate:new Date(`${day(offset)}T10:00:00Z`),principalDue:150000,interestDue:7500,feesDue:0,totalDue:157500}))})
   loans.push({...loan,label})
  }
  writeFileSync('/tmp/cf-nca-browser.json',JSON.stringify({tenantId:fx.tenantId,slug:`af-deal-${token}`,staff,password,secret,loans},null,2),{mode:0o600})
 } finally {await db.$disconnect()}
},180_000)
