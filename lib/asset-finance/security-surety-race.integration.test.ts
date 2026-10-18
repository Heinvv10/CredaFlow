import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { beforeAll, afterAll, it, expect, vi } from 'vitest'
import { createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from './deal-signing.integration-fixture'
import { dealStartDate } from './deal-structure'
import { isoOfDbDate } from './dates'
const { session } = vi.hoisted(() => ({ session: { current: null as any } }))
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.current) }))
const db = new PrismaClient()
let fx: SigningFixture
beforeAll(async () => {
 vi.stubEnv('TRUSTED_PROXY','1')
 const t = randomUUID().replaceAll('-','').slice(0,16)
 fx = await createSigningFixture(db,t,(id,role) => { session.current={user:{id,role,email:'test@review.invalid',tenantId:`t_af_deal_${t}`}} })
 await db.tenantConfig.update({where:{tenantId:fx.tenantId},data:SYNTHETIC_IDENTITY})
 const deal=await db.assetFinanceDeal.findUniqueOrThrow({where:{id:fx.dealId}})
 session.current={user:{id:fx.officer,role:'CREDIT_OFFICER',email:'test@review.invalid',tenantId:fx.tenantId}}
 expect((await signingRoutes(fx.host).prepare(fx.dealId,{plannedStartDate:dealStartDate(isoOfDbDate(deal.firstDueDate))})).status).toBe(200)
},120000)
afterAll(async()=>{ await db.$disconnect(); vi.unstubAllEnvs() })
it('retains a consent proof when deletion races its first reference',async()=>{
 const signer=await db.dealSigner.findFirstOrThrow({where:{dealId:fx.dealId,document:'SURETYSHIP'}})
 const doc=await db.entityDocument.create({data:{tenantId:fx.tenantId,entityId:fx.evidenced,dealId:fx.dealId,docType:'LEGAL_DOCUMENT',fileName:'TEST-consent.pdf',mimeType:'application/pdf',fileSize:10,storagePath:'/tmp/TEST-security-consent',contentSha256:'a'.repeat(64),uploadedByType:'staff',uploadedById:fx.officer}})
 let inserted!:()=>void; const insertReady=new Promise<void>(r=>inserted=r)
 let release!:()=>void; const canCommit=new Promise<void>(r=>release=r)
 const create=db.$transaction(async tx=>{
  const row=await tx.suretyConsent.create({data:{tenantId:fx.tenantId,signerId:signer.id,maritalRegime:'IN_COMMUNITY',spouseName:'TEST Spouse',witnessOne:'TEST One',witnessTwo:'TEST Two',evidenceDocumentId:doc.id,verifiedById:fx.officer,suretySignedOn:new Date('2026-10-17'),consentSignedOn:new Date('2026-10-16'),consentBeforeSurety:true}})
  inserted(); await canCommit; return row
 },{timeout:15000})
 await insertReady
 try { await db.entityDocument.update({where:{id:doc.id},data:{deletedAt:new Date(),deletedById:fx.officer}}) } finally { release() }
 const consent=await create
 const retained=await db.entityDocument.findUniqueOrThrow({where:{id:consent.evidenceDocumentId!}})
 console.log('Committed consent',consent.id,'proof deletedAt',retained.deletedAt)
 expect(retained.deletedAt).toBeNull()
},30000)
