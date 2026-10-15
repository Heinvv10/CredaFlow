/**
 * Slice 4a sale and refund integrity (real migrated Postgres, real routes),
 * from the edge-case tester's attacks: a staff member cannot propose, approve
 * or complete the sale of an asset to themselves (their own name or one of
 * their own conflict declarations names the buyer); a surplus refund moves
 * only while the proceeds stand, so a reversed proceeds receipt or a reopened
 * loan stops it at create, approve and release. The policies are UNTESTED
 * against the law: these prove the rules as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-sale-integrity.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { testSetup } from "./lease-servicing.integration-fixture"
import { advance } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { plainListed, readJson, refundForm, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const as = (id: string, role: "CREDIT_OFFICER" | "LOAN_ADMIN") => { session.current = { user: { id, email: `${id}@recovery-it.test`, role, tenantId: fx.tenantId } } }
const officer = () => as(fx.officer, "CREDIT_OFFICER")
const adminA = () => as(fx.adminA, "LOAN_ADMIN")
const adminB = () => as(fx.adminB, "LOAN_ADMIN")
const routes = () => saleRoutes(fx.host)
const status = async (response: Promise<Response>) => (await readJson(await response)).status

/** A NCA recovery taken to SURPLUS_HELD by the routes (price above the settlement). */
async function surplusHeld() {
  const rec = await plainListed(database(), fx, "NCA", 100_000_000)
  officer()
  const sale = (await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 200_000_000)))).body.id as string
  expect(await status(routes().completeSale(rec.id, sale))).toBe(200)
  expect(await status(routes().proceeds(rec.id))).toBe(200)
  await advance(database(), fx, rec.loan, rec.id, "FINAL_NOTICE_ISSUED")
  expect((await readJson(await routes().outcome(rec.id))).body).toMatchObject({ status: "SURPLUS_HELD" })
  return rec
}

suite.sequential("sale and refund integrity (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
    await database().user.update({ where: { id: fx.adminB }, data: { name: "Lerato Mokgadi-Buyer" } })
    await database().user.update({ where: { id: fx.officer }, data: { name: "Pieter van der Merwe" } })
  }, 120_000)

  afterAll(async () => {
    await database().coiDeclaration.deleteMany({ where: { tenantId: fx.tenantId } }).catch(() => undefined)
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("a staff member buying cannot approve or complete their own purchase, however their name is written", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    officer()
    const proposed = await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: "T Mokgadi-Buyer, Lerato", buyerIdentifier: "ZZ-STAFF-1" })))
    expect(proposed.body).toMatchObject({ relatedPartyMatch: true, approvalRequired: true })
    const sale = proposed.body.id as string
    adminB()
    expect((await readJson(await routes().approveSale(rec.id, sale))).status).toBe(409)
    expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(409)
    adminA()
    expect((await readJson(await routes().approveSale(rec.id, sale))).status).toBe(200)
    adminB()
    expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(409) // approved, but the buyer completing it is the buyer
    officer()
    expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(200)
    expect(await database().remarketingSale.findUniqueOrThrow({ where: { id: sale } })).toMatchObject({ status: "COMPLETED", approvedById: fx.adminA })
  }, 120_000)

  it("the proposer cannot be the buyer", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    officer()
    for (const buyerName of ["Pieter van der Merwé", "P. Vandermerwe", "pieter VAN DER merwe"]) {
      expect(await status(routes().propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName, buyerIdentifier: "ZZ-STAFF-2" })))).toBe(409)
    }
    expect(await database().remarketingSale.count({ where: { recoveryId: rec.id } })).toBe(0)
    adminA()
    expect(await status(routes().propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: "Pieter van der Berg", buyerIdentifier: "ZZ-STAFF-3" })))).toBe(201)
  }, 120_000)

  it("a conflict declaration of the acting user naming the buyer stops them, flagged or not", async () => {
    await database().coiDeclaration.create({ data: { tenantId: fx.tenantId, userId: fx.adminA, year: Number(sastCalendarDate(new Date()).slice(0, 4)) - 1, hasConflict: false, details: "My brother owns Zzyzx Plant Hire" } })
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    adminA()
    expect(await status(routes().propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: "ZZYZX Plant Hire (Pty) Ltd", buyerType: "ENTITY", buyerIdentifier: "2098/700002/07" })))).toBe(409)
    adminB()
    expect(await status(routes().propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: "Zzyzx Plant Hire", buyerType: "ENTITY", buyerIdentifier: "2098/700002/07" })))).toBe(201)
  }, 120_000)

  it("a refund stops at create, approve and release once the proceeds receipt is reversed or the loan is reopened", async () => {
    const reversedBefore = await surplusHeld()
    const reopened = await surplusHeld()
    const reversedLater = await surplusHeld()
    const payment = (rec: { id: string }) => database().recovery.findUniqueOrThrow({ where: { id: rec.id }, select: { proceedsPaymentId: true } }).then((r) => r.proceedsPaymentId as string)

    // Reversed before anyone creates the refund.
    await testSetup(database(), [`UPDATE "Payment" SET "reversed" = true WHERE "id" = $1`, await payment(reversedBefore)])
    adminA()
    expect(await status(routes().refund(reversedBefore.id, refundForm()))).toBe(409)
    expect(await database().recoveryRefund.count({ where: { recoveryId: reversedBefore.id } })).toBe(0)

    // Loan reopened after the refund was created.
    expect(await status(routes().refund(reopened.id, refundForm()))).toBe(201)
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'ACTIVE' WHERE "id" = $1`, reopened.loan.loanId])
    adminB()
    expect(await status(routes().approveRefund(reopened.id))).toBe(409)

    // Reversed between approval and release.
    adminA()
    expect(await status(routes().refund(reversedLater.id, refundForm()))).toBe(201)
    adminB()
    expect(await status(routes().approveRefund(reversedLater.id))).toBe(200)
    await testSetup(database(), [`UPDATE "Payment" SET "reversed" = true WHERE "id" = $1`, await payment(reversedLater)])
    const third = (await database().user.create({ data: { tenantId: fx.tenantId, email: `admin-c-${t}@staff.invalid`, password: "x", role: "LOAN_ADMIN" } })).id
    as(third, "LOAN_ADMIN")
    expect(await status(routes().releaseRefund(reversedLater.id))).toBe(409)
    expect(await database().recoveryRefund.findUniqueOrThrow({ where: { recoveryId: reversedLater.id } })).toMatchObject({ status: "APPROVED" })
    expect(await database().recovery.findUniqueOrThrow({ where: { id: reversedLater.id } })).toMatchObject({ status: "SURPLUS_HELD" })
  }, 240_000)
})
