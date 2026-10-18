/**
 * Slice 4a review fixes through the real routes (real migrated Postgres):
 * the settlement is read under the loan's lock, so a receipt landing first is
 * in it; costs deducted from the proceeds can never swallow the sale price (at
 * completion, or when a cost is approved on a sold recovery); and when the
 * database flags a buyer the screening missed, the stored screening result
 * says so (kind only) and the flag is audited. The policies are UNTESTED
 * against the law: these prove the rules as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-sale-review.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { POST as decideCostRoute } from "@/app/api/asset-finance/recoveries/[id]/costs/[costId]/decide/route"
import { recordDecidedCost, costData } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { plainListed, readJson, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
vi.mock("./recovery-screening", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recovery-screening")>()
  return { ...actual, screenBuyer: vi.fn(actual.screenBuyer) }
})
import * as screening from "./recovery-screening"

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
const adminB = () => as(fx.adminB, "LOAN_ADMIN")
const routes = () => saleRoutes(fx.host)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

suite.sequential("sale review fixes (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
  }, 120_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("reads the settlement under the loan's lock: a receipt that lands first is in the figure", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 50_000_000)
    officer()
    const sale = (await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 60_000_000)))).body.id as string
    expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(200)

    // Another writer holds the loan; the proceeds must wait for it, then see its receipt.
    let release = () => undefined as void
    let locked = () => undefined as void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holding = new Promise<void>((resolve) => { locked = resolve })
    const writer = database().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.$queryRaw`SELECT 1 FROM "Loan" WHERE id = ${rec.loan.loanId} FOR UPDATE`
      locked()
      await gate
      await tx.payment.create({ data: { tenantId: fx.tenantId, loanId: rec.loan.loanId, amount: 5_000_000, paymentMethod: "EFT", receivedAt: new Date(), allocationStatus: "ALLOCATED" } })
      await tx.$executeRaw`UPDATE "Loan" SET "totalPaid" = "totalPaid" + 5000000 WHERE id = ${rec.loan.loanId}`
      await tx.repaymentSchedule.updateMany({ where: { loanId: rec.loan.loanId }, data: { totalPaid: 5_000_000, status: "PARTIAL" } })
    }, { timeout: 30_000 })
    await holding
    const proceeds = routes().proceeds(rec.id)
    await sleep(700)
    release()
    await writer
    expect((await readJson(await proceeds)).status).toBe(200)
    // The earned-period settlement excludes the unearned cent, then nets the R50,000 cash.
    expect((await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).settlementDueCents).toBe(150_000_000 - 5_000_000)
  }, 120_000)

  it("refuses to complete a sale whose price the approved deducted costs already swallow, and to approve such a cost once sold", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 50_000_000)
    await recordDecidedCost(database(), fx, rec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 60_000_000 })
    officer()
    const sale = (await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 60_000_000)))).body.id as string
    expect(await readJson(await routes().completeSale(rec.id, sale))).toMatchObject({ status: 409, body: { error: expect.stringMatching(/nothing would be left/) } })

    const second = await plainListed(database(), fx, "NON_NCA", 50_000_000)
    await recordDecidedCost(database(), fx, second.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 10_000_000 })
    const secondSale = (await readJson(await routes().propose(second.id, saleBody(second.valuationId, 60_000_000)))).body.id as string
    expect((await readJson(await routes().completeSale(second.id, secondSale))).status).toBe(200)
    // Sold: a further deductible cost that would take the total to the price is refused; one that leaves something is fine.
    const decide = (recoveryId: string, costId: string) => decideCostRoute(
      new NextRequest(`http://${fx.host}/x`, { method: "POST", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify({ decision: "APPROVED" }) }),
      { params: Promise.resolve({ id: recoveryId, costId }) },
    )
    const swallowing = await database().recoveryCost.create({ data: costData(fx, second.id, { type: "STORAGE", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 50_000_000 }) })
    const modest = await database().recoveryCost.create({ data: costData(fx, second.id, { type: "STORAGE", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 1_000_000 }) })
    adminB()
    expect((await readJson(await decide(second.id, swallowing.id))).status).toBe(409)
    expect((await readJson(await decide(second.id, modest.id))).status).toBe(200)
    expect(await database().recoveryCost.findUniqueOrThrow({ where: { id: swallowing.id } })).toMatchObject({ status: "PENDING" })
  }, 120_000)

  it("serialises cost approvals: two that fit alone but not together cannot both be approved, nor can one race the completion", async () => {
    const decide = (recoveryId: string, costId: string) => decideCostRoute(
      new NextRequest(`http://${fx.host}/x`, { method: "POST", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify({ decision: "APPROVED" }) }),
      { params: Promise.resolve({ id: recoveryId, costId }) },
    )
    const pendingCost = (recoveryId: string, grossCents: number) =>
      database().recoveryCost.create({ data: costData(fx, recoveryId, { type: "STORAGE", treatment: "DEDUCT_FROM_PROCEEDS", grossCents }) })
    // Several rounds, so an unlocked check would be caught by chance at least once.
    for (let round = 0; round < 6; round++) {
      const rec = await plainListed(database(), fx, "NON_NCA", 50_000_000)
      await recordDecidedCost(database(), fx, rec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 10_000_000 })
      officer()
      const sale = (await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 60_000_000)))).body.id as string
      expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(200)
      // R10m approved of a R60m price: R30m alone fits (40 < 60), two together do not (70 >= 60).
      const [a, b] = [await pendingCost(rec.id, 30_000_000), await pendingCost(rec.id, 30_000_000)]
      adminB()
      const decided = await Promise.all([decide(rec.id, a.id), decide(rec.id, b.id)].map(async (response) => (await readJson(await response)).status))
      expect(decided.sort(), `round ${round}`).toEqual([200, 409])
      const approved = await database().recoveryCost.aggregate({ where: { recoveryId: rec.id, status: "APPROVED", treatment: "DEDUCT_FROM_PROCEEDS" }, _sum: { grossCents: true } })
      expect(approved._sum.grossCents).toBe(40_000_000)
    }
    // An approval racing the completion: whichever the lock lets in first, the other sees it and refuses.
    for (let round = 0; round < 6; round++) {
      const rec = await plainListed(database(), fx, "NON_NCA", 50_000_000)
      await recordDecidedCost(database(), fx, rec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 5_000_000 })
      const swallowing = await pendingCost(rec.id, 56_000_000)
      officer()
      const sale = (await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 60_000_000)))).body.id as string
      adminB() // an administrator may complete a sale too, so one session serves both calls
      const [approval, completion] = await Promise.all([decide(rec.id, swallowing.id), routes().completeSale(rec.id, sale)])
      const statuses = [(await readJson(approval)).status, (await readJson(completion)).status].sort()
      expect(statuses, `round ${round}`).toEqual([200, 409])
    }
  }, 240_000)

  it("records the database's own reason when it flags a buyer the screening missed", async () => {
    const rec = await plainListed(database(), fx, "NCA", 50_000_000)
    officer()
    // The first screening is the proposer-is-the-buyer check, the second the sale's own.
    vi.mocked(screening.screenBuyer).mockReturnValueOnce({ match: false, matches: [] }).mockReturnValueOnce({ match: false, matches: [] })
    const proposed = await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 60_000_000, { buyerIdentifier: rec.loan.borrowerKey })))
    expect(proposed).toMatchObject({ status: 201, body: { relatedPartyMatch: true, approvalRequired: true } })
    const sale = await database().remarketingSale.findUniqueOrThrow({ where: { id: proposed.body.id as string } })
    expect(sale).toMatchObject({ relatedPartyMatch: true, screeningResult: { match: true, matches: [{ kind: "BORROWER_IDENTIFIER_DB", on: "IDENTIFIER" }] } })
    expect(await database().remarketingSale.count({ where: { recoveryId: rec.id } })).toBe(1)
    const audit = JSON.stringify(await database().auditLog.findMany({ where: { tenantId: fx.tenantId, entityId: sale.id }, select: { action: true, newValue: true } }))
    expect(audit).toContain("ASSET_REMARKETING_RELATED_PARTY_FLAGGED")
    expect(audit).toContain("BORROWER_IDENTIFIER_DB")
    expect(audit).not.toContain(rec.loan.borrowerKey)
  }, 120_000)
})
