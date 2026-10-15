/**
 * Segregation-of-duties repro (automated scan on 1a474cdb): the approval
 * gate's runs were recorded as system runs, so an approver could trigger a run
 * at decide, clear the PEP match themselves, then approve. With
 * requireSecondReviewer on, the gate now records the approver as the run's
 * maker, so they cannot decide its matches and the approval stays refused
 * until someone else decides. Red on 1a474cdb, green after. R2: a self-approved
 * RMCP version cannot be inserted either.
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/breaker-repros-round3.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { reviewScreeningCheck } from "./review"
import { borrowerScreeningGate } from "./gate"

const RUN = process.env.RUN_SCREENING_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `tenant_sod_${token}`
const product = `product_sod_${token}`
const approver = { id: `approver_${token}`, email: `approver-${token}@test.invalid`, role: "ADMIN" as const, totpVerified: true }
const colleague = { id: `colleague_${token}`, email: `colleague-${token}@test.invalid`, role: "ADMIN" as const, totpVerified: true }
const n = () => randomUUID().slice(0, 8)

async function pepApplication(): Promise<{ clientId: string; appId: string }> {
  const clientId = `sod_${n()}`
  await db.client.create({ data: {
    id: clientId, tenantId, reference: `REF-${clientId}`, idNumber: `ID-${clientId}`, firstName: "Synthetic", lastName: "Fixture-Pep",
    email: `${clientId}@test.invalid`, phone: "+27820000000",
  } })
  const appId = `sod_app_${n()}`
  await db.$executeRawUnsafe(
    `INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 500000, 30, 'UNDER_REVIEW', now())`, appId, tenantId, `APP-${appId}`, clientId, product)
  return { clientId, appId }
}
const gate = (clientId: string, appId: string) =>
  borrowerScreeningGate({ tenantId, borrower: { clientId, entityId: null }, applicationId: appId, actor: approver })
const openMatch = async (clientId: string) =>
  (await db.screeningCheck.findFirst({ where: { tenantId, clientId, result: "CONFIRMED_MATCH" }, orderBy: { createdAt: "desc" } }))!
const accept = (checkId: string, by: typeof approver) =>
  reviewScreeningCheck({ tenantId, checkId, decision: "ACCEPTED", reason: "PEP accepted with enhanced due diligence.", actor: by, totpWaived: false })
const setSecondReviewer = (on: boolean) => db.tenantConfig.updateMany({ where: { tenantId }, data: { requireSecondReviewer: on } })

suite("segregation of duties at approval", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `sod-${token}`, name: "SoD repro" } })
    await db.tenantConfig.create({ data: { tenantId, screeningProvider: "simulated", screeningReviewMinRole: "ADMIN", requireStaffTotp: true, requireSecondReviewer: true } })
    await db.user.createMany({ data: [approver, colleague].map((u) => ({ id: u.id, tenantId, email: u.email, password: "x", role: u.role })) })
    await db.$executeRawUnsafe(
      `INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
       VALUES ($1, $2, $3, 'SoD product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL')`, product, tenantId, `SOD-${token}`)
  })
  afterAll(async () => db.$disconnect())

  it("approver triggers the run at decide, tries to clear the PEP match, then approves: refused (second reviewer on)", async () => {
    await setSecondReviewer(true)
    const { clientId, appId } = await pepApplication()
    expect(await gate(clientId, appId)).toMatchObject({ allowed: false, state: { state: "REFER" } })
    const match = await openMatch(clientId)
    expect(match.triggeredById).toBe(approver.id)
    expect(await accept(match.id, approver)).toMatchObject({ ok: false, code: "own_run" })
    expect((await gate(clientId, appId)).allowed).toBe(false)
    expect(await accept(match.id, colleague)).toMatchObject({ ok: true })
    expect((await gate(clientId, appId)).allowed).toBe(true)
  })

  it("with the second-reviewer requirement off, the gate's run is a system run the approver may decide", async () => {
    await setSecondReviewer(false)
    const { clientId, appId } = await pepApplication()
    await gate(clientId, appId)
    const match = await openMatch(clientId)
    expect(match.triggeredById).toBeNull()
    expect(await accept(match.id, approver)).toMatchObject({ ok: true })
    await setSecondReviewer(true)
  })

  it("R2: a self-approved RMCP version cannot be inserted while a second reviewer is required", async () => {
    await setSecondReviewer(true)
    const insert = (id: string) => db.$executeRawUnsafe(
      `INSERT INTO "RmcpDocument" ("id", "tenantId", "version", "title", "fileName", "mimeType", "storagePath", "sha256", "fileSize", "uploadedById", "approvedById", "approvedAt", "reviewDueAt")
       VALUES ($1, $2, $3, 'RMCP', 'rmcp.pdf', 'application/pdf', '/tmp/none.pdf', $4, 10, $5, $5, now(), '2027-10-14')`,
      id, tenantId, Math.floor(Math.random() * 1e6) + 1, "a".repeat(64), approver.id)
    await expect(insert(`rmcp_${n()}`)).rejects.toThrow(/uploaded an RMCP version does not approve it/)
  })
})
