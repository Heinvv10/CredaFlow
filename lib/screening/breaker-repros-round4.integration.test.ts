/**
 * Segregation of duties, second half (coordinator, after 1f143b40): with
 * requireSecondReviewer on, the user who DECIDED a match the borrower's
 * current screening relies on — directly or through a carried decision —
 * cannot approve the application. Gate, in-transaction re-check and trigger.
 * Red on 1f143b40, green after.
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/breaker-repros-round4.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runScreening } from "./run"
import { reviewScreeningCheck } from "./review"
import { borrowerScreeningGate, lockedBorrowerScreeningAllows } from "./gate"

const RUN = process.env.RUN_SCREENING_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `tenant_sod2_${token}`
const product = `product_sod2_${token}`
const user = (name: string) => ({ id: `${name}_${token}`, email: `${name}-${token}@test.invalid`, role: "ADMIN" as const, totpVerified: true })
const colleague = user("colleague")
const approver = user("approver")
const third = user("third")
const n = () => randomUUID().slice(0, 8)

async function pepApplication(): Promise<{ clientId: string; appId: string }> {
  const clientId = `sod2_${n()}`
  await db.client.create({ data: {
    id: clientId, tenantId, reference: `REF-${clientId}`, idNumber: `ID-${clientId}`, firstName: "Synthetic", lastName: "Fixture-Pep",
    email: `${clientId}@test.invalid`, phone: "+27820000000",
  } })
  const appId = `sod2_app_${n()}`
  await db.$executeRawUnsafe(
    `INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 500000, 30, 'UNDER_REVIEW', now())`, appId, tenantId, `APP-${appId}`, clientId, product)
  return { clientId, appId }
}
const openMatch = async (clientId: string) =>
  (await db.screeningCheck.findFirst({ where: { tenantId, clientId, result: "CONFIRMED_MATCH" }, orderBy: { createdAt: "desc" } }))!
const gateAs = (by: typeof approver, clientId: string, appId: string) =>
  borrowerScreeningGate({ tenantId, borrower: { clientId, entityId: null }, applicationId: appId, actor: by })
const recheckAs = (by: typeof approver, clientId: string) =>
  prisma.$transaction((tx) => lockedBorrowerScreeningAllows(tx, tenantId, { clientId, entityId: null }, by.id))

/** The approval write by `approvedById`, every OTHER LoanApplication guard out of the way; rolled back. */
async function approveAs(appId: string, approvedById: string): Promise<string | null> {
  const others = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = '"LoanApplication"'::regclass AND NOT tgisinternal AND tgname <> 'LoanApplication_a1_guard_screening'`)
  const checks = await db.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT conname FROM pg_constraint WHERE conrelid = '"LoanApplication"'::regclass AND contype = 'c'`)
  const rollback = new Error("rollback")
  try {
    await db.$transaction(async (tx) => {
      for (const t of others) await tx.$executeRawUnsafe(`ALTER TABLE "LoanApplication" DISABLE TRIGGER "${t.tgname}"`)
      for (const c of checks) await tx.$executeRawUnsafe(`ALTER TABLE "LoanApplication" DROP CONSTRAINT "${c.conname}"`)
      await tx.$executeRawUnsafe(`UPDATE "LoanApplication" SET status = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = now(), "approvedById" = $2 WHERE id = $1`, appId, approvedById)
      throw rollback
    })
  } catch (error) {
    return error === rollback ? null : String(error)
  }
  return null
}

suite("segregation of duties: the decider of a relied-on match does not approve", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `sod2-${token}`, name: "SoD repro 2" } })
    await db.tenantConfig.create({ data: { tenantId, screeningProvider: "simulated", screeningReviewMinRole: "ADMIN", requireStaffTotp: true, requireSecondReviewer: true } })
    await db.user.createMany({ data: [colleague, approver, third].map((u) => ({ id: u.id, tenantId, email: u.email, password: "x", role: u.role })) })
    await db.$executeRawUnsafe(
      `INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
       VALUES ($1, $2, $3, 'SoD2 product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL')`, product, tenantId, `SOD2-${token}`)
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("colleague's run, approver decides, approver approves: refused; a third person approves: allowed", async () => {
    const { clientId, appId } = await pepApplication()
    await runScreening({ tenantId, subject: { clientId }, trigger: "MANUAL", actor: colleague })
    const decided = await reviewScreeningCheck({
      tenantId, checkId: (await openMatch(clientId)).id, decision: "ACCEPTED",
      reason: "PEP accepted with enhanced due diligence.", actor: approver, totpWaived: false,
    })
    expect(decided).toMatchObject({ ok: true })
    expect(await gateAs(approver, clientId, appId)).toMatchObject({ allowed: false, selfDecided: true })
    expect(await recheckAs(approver, clientId)).toBe(false)
    expect(await approveAs(appId, approver.id)).toContain("decided a screening match")
    expect((await gateAs(third, clientId, appId)).allowed).toBe(true)
    expect(await recheckAs(third, clientId)).toBe(true)
    expect(await approveAs(appId, third.id)).toBeNull()
  })

  it("follows a carried decision back to its original decider", async () => {
    const { clientId, appId } = await pepApplication()
    await runScreening({ tenantId, subject: { clientId }, trigger: "MANUAL", actor: colleague })
    await reviewScreeningCheck({
      tenantId, checkId: (await openMatch(clientId)).id, decision: "ACCEPTED",
      reason: "PEP accepted with enhanced due diligence.", actor: approver, totpWaived: false,
    })
    await runScreening({ tenantId, subject: { clientId }, trigger: "MANUAL", actor: colleague })
    const carried = await openMatch(clientId)
    expect(carried).toMatchObject({ decision: "ACCEPTED", reviewedById: null })
    expect(carried.carriedFromCheckId).not.toBeNull()
    expect((await gateAs(approver, clientId, appId)).allowed).toBe(false)
    expect(await approveAs(appId, approver.id)).toContain("decided a screening match")
    expect(await approveAs(appId, third.id)).toBeNull()
  })

  it("does not apply when the lender has turned the second-reviewer requirement off", async () => {
    await db.tenantConfig.updateMany({ where: { tenantId }, data: { requireSecondReviewer: false } })
    try {
      const { clientId, appId } = await pepApplication()
      await runScreening({ tenantId, subject: { clientId }, trigger: "MANUAL", actor: colleague })
      await reviewScreeningCheck({
        tenantId, checkId: (await openMatch(clientId)).id, decision: "ACCEPTED",
        reason: "PEP accepted with enhanced due diligence.", actor: approver, totpWaived: false,
      })
      expect((await gateAs(approver, clientId, appId)).allowed).toBe(true)
      expect(await approveAs(appId, approver.id)).toBeNull()
    } finally {
      await db.tenantConfig.updateMany({ where: { tenantId }, data: { requireSecondReviewer: true } })
    }
  })
})
