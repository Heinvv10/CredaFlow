/**
 * Slice 4a: a sale needs a second approver when the valuation it relies on, or
 * the highest current independent valuation, was recorded by the person who
 * proposes it (SELF_VALUED), so nobody sets a price floor and sells at it alone.
 * Real migrated Postgres, real routes. The reason is stored on the sale as
 * screeningResult.selfValued. The policy is UNTESTED against the law: these
 * prove the rule as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-sale-self-valued.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type ValuationSource } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, today, type RecoveryFixture } from "./recovery.integration-fixture"
import { plainListed, readJson, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
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

/** `valuations` are recorded by `by` (the plain recovery's own valuation, 100 000 000, is the first admin's). */
async function valuedBy(by: string, amountCents: number, assetId: string, source: ValuationSource = "ASSESSOR"): Promise<string> {
  return (await database().assetValuation.create({ data: { tenantId: fx.tenantId, assetId, valuedOn: dbDate(today()), source, valuerName: "TEST Valuers", amountCents, createdById: by } })).id
}
const propose = async (rec: { id: string }, valuationId: string, price: number) => readJson(await routes().propose(rec.id, saleBody(valuationId, price)))

suite.sequential("a sale on a valuation its proposer recorded (SELF_VALUED)", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
  }, 120_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("control: a sale at the valuation of someone else needs no approval", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    officer()
    const sale = await propose(rec, rec.valuationId, 100_000_000)
    expect(sale).toMatchObject({ status: 201, body: { belowValuation: false, selfValued: false, approvalRequired: false } })
    expect((await readJson(await routes().completeSale(rec.id, sale.body.id as string))).status).toBe(200)
  }, 120_000)

  it("the proposer's own valuation, at its price, needs a second approver who is not the proposer", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    const asset = (await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).assetId
    const own = await valuedBy(fx.officer, 150_000_000, asset)
    officer()
    const sale = await propose(rec, own, 150_000_000)
    expect(sale).toMatchObject({ status: 201, body: { belowValuation: false, relatedPartyMatch: false, selfValued: true, approvalRequired: true } })
    const id = sale.body.id as string
    expect((await database().remarketingSale.findUniqueOrThrow({ where: { id } })).screeningResult).toMatchObject({ selfValued: true })
    expect((await readJson(await routes().completeSale(rec.id, id))).status).toBe(409)
    expect((await readJson(await routes().approveSale(rec.id, id))).status).toBe(403) // the proposer's role cannot approve
    adminB()
    expect((await readJson(await routes().approveSale(rec.id, id))).status).toBe(200)
    officer()
    expect((await readJson(await routes().completeSale(rec.id, id))).status).toBe(200)
    expect(await database().remarketingSale.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "COMPLETED", approvedById: fx.adminB, createdById: fx.officer })
  }, 120_000)

  it("an administrator who recorded the valuation cannot approve their own sale", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    adminA() // recorded the recovery's own valuation
    const sale = await propose(rec, rec.valuationId, 100_000_000)
    expect(sale.body).toMatchObject({ selfValued: true, approvalRequired: true })
    const id = sale.body.id as string
    expect((await readJson(await routes().approveSale(rec.id, id))).status).toBe(409)
    expect((await readJson(await routes().completeSale(rec.id, id))).status).toBe(409)
    adminB()
    expect((await readJson(await routes().approveSale(rec.id, id))).status).toBe(200)
    adminA()
    expect((await readJson(await routes().completeSale(rec.id, id))).status).toBe(200)
  }, 120_000)

  it("citing someone else's valuation does not help when the highest current one is the proposer's, or ties with it", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    const asset = (await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).assetId
    officer()
    await valuedBy(fx.officer, 100_000_000, asset) // ties the first admin's
    expect((await propose(rec, rec.valuationId, 100_000_000)).body).toMatchObject({ selfValued: true, approvalRequired: true })
    await valuedBy(fx.officer, 150_000_000, asset) // now the highest
    expect((await propose(rec, rec.valuationId, 150_000_000)).body).toMatchObject({ belowValuation: false, selfValued: true, approvalRequired: true })
  }, 120_000)

  it("a valuation of the proposer's counts when it is the one relied on, not when it is merely on file", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    const asset = (await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).assetId
    const low = await valuedBy(fx.officer, 5_000_000, asset, "DEALER")
    officer()
    expect((await propose(rec, rec.valuationId, 100_000_000)).body).toMatchObject({ selfValued: false, approvalRequired: false })
    // Citing it, though, is relying on it: even a low one of the proposer's, with the price at the highest, needs the approver.
    expect((await propose(rec, low, 100_000_000)).body).toMatchObject({ belowValuation: false, selfValued: true, approvalRequired: true })
  }, 120_000)

  it("a sale that became self-valued after it was recorded must be re-recorded: no approval completes it", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    const asset = (await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).assetId
    officer()
    const sale = await propose(rec, rec.valuationId, 100_000_000)
    expect(sale.body).toMatchObject({ approvalRequired: false, selfValued: false })
    const id = sale.body.id as string
    await valuedBy(fx.officer, 100_000_000, asset) // ties the highest, recorded by the proposer
    const refusal = /re-recorded as self-valued/
    expect(await readJson(await routes().completeSale(rec.id, id))).toMatchObject({ status: 409, body: { error: expect.stringMatching(refusal) } })
    adminB()
    expect(await readJson(await routes().approveSale(rec.id, id))).toMatchObject({ status: 409, body: { error: expect.stringMatching(refusal) } })
    officer()
    expect((await readJson(await routes().completeSale(rec.id, id))).status).toBe(409)
    // Recorded again, it is flagged and goes the approver's way.
    expect((await readJson(await routes().cancelSale(rec.id, id))).status).toBe(200)
    const again = await propose(rec, rec.valuationId, 100_000_000)
    expect(again.body).toMatchObject({ selfValued: true, approvalRequired: true })
    expect((await database().remarketingSale.findUniqueOrThrow({ where: { id: again.body.id as string } })).selfValued).toBe(true)
    adminB()
    expect((await readJson(await routes().approveSale(rec.id, again.body.id as string))).status).toBe(200)
    officer()
    expect((await readJson(await routes().completeSale(rec.id, again.body.id as string))).status).toBe(200)
  }, 120_000)
})
