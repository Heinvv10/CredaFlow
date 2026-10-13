/**
 * Real-Postgres proof that concurrent bureau runs for one deal make one
 * consumer enquiry per person (review round 3): runDealBureauCheck takes a
 * transaction-scoped advisory lock per (application, person) around the
 * stored-check lookup, the enquiry and its rows. The provider call is stubbed
 * (slow, counted) so the two requests overlap; the database, the lock and the
 * rows are real.
 *
 *   RUN_ASSET_FINANCE_DEAL_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/deal-bureau-race.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped } from "./dates"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, dealRoutes, type DealFixture } from "./deal.integration-fixture"
import { runDealBureauCheck, type DealBureauSubject } from "./deal-bureau"

const m = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
  enquiries: 0,
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => m.session.current) }))
vi.mock("@/lib/integrations/experian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/experian")>()),
  getCreditReport: vi.fn(async () => {
    m.enquiries += 1
    await new Promise((resolve) => setTimeout(resolve, 400))
    return { ok: true, score: 700, riskGrade: "B" }
  }),
}))

const RUN = process.env.RUN_ASSET_FINANCE_DEAL_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealFixture
let applicationId = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_DEAL_IT=1 is required")
  return db
}
const subject = (): DealBureauSubject => ({ clientId: fx.director, role: "DIRECTOR", trusteeKind: null })
const stored = () => database().creditBureauCheck.count({ where: { tenantId: fx.tenantId, applicationId, clientId: fx.director } })

suite.sequential("bureau checks: one enquiry per person under concurrency (real Postgres)", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t)
    m.session.current = { user: { id: fx.officer, email: `${fx.officer}@bureau-it.test`, role: "CREDIT_OFFICER", tenantId: fx.tenantId } }
    const created = await dealRoutes(fx.host).create({
      assetId: fx.assets[0], depositCents: 17_250_000, balloonCents: 0, firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 2),
      preset: { kind: "MONTHLY", periods: 60 }, rateBasis: "PRIME", rateMargin: "0.0100",
      entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product,
    })
    expect(created.status).toBe(201)
    const dealId = ((await created.json()) as { id: string }).id
    applicationId = (await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })).applicationId
  })

  afterAll(async () => {
    if (!db) return
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("two concurrent runs: one enquiry, one stored check; the other run answers recent", async () => {
    m.enquiries = 0
    const startedAt = new Date()
    const outcomes = await Promise.all([1, 2].map(() => runDealBureauCheck(fx.tenantId, applicationId, subject(), { force: false, startedAt })))
    expect(outcomes.sort()).toEqual(["recent", "stored"])
    expect(m.enquiries).toBe(1)
    expect(await stored()).toBe(1)
  })

  it("two concurrent forced re-runs: one new enquiry (the second sees a check stored since it started)", async () => {
    m.enquiries = 0
    const startedAt = new Date()
    const outcomes = await Promise.all([1, 2].map(() => runDealBureauCheck(fx.tenantId, applicationId, subject(), { force: true, startedAt })))
    expect(outcomes.sort()).toEqual(["recent", "stored"])
    expect(m.enquiries).toBe(1)
    expect(await stored()).toBe(2)
  })

  it("a forced run after the window check still enquires; an unforced one inside the window does not", async () => {
    m.enquiries = 0
    expect(await runDealBureauCheck(fx.tenantId, applicationId, subject(), { force: false, startedAt: new Date() })).toBe("recent")
    expect(await runDealBureauCheck(fx.tenantId, applicationId, subject(), { force: true, startedAt: new Date() })).toBe("stored")
    expect(m.enquiries).toBe(1)
  })
})
