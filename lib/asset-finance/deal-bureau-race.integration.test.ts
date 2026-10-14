/**
 * Real-Postgres proof that concurrent bureau runs for one deal make one
 * consumer enquiry per person (review round 3): runDealBureauCheck takes a
 * transaction-scoped advisory lock per (application, person) around the
 * stored-check lookup, the enquiry and its rows. The provider call is stubbed
 * (slow, counted) so the two requests overlap; the database, the lock and the
 * rows are real. The wait for the lock is bounded ("busy"), and an enquiry
 * whose transaction fails after the provider call still leaves a record.
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

type Report = { ok: boolean; score?: number; riskGrade?: string }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const slowReport = async (): Promise<Report> => {
  await sleep(400)
  return { ok: true, score: 700, riskGrade: "B" }
}
const m = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
  enquiries: 0,
  // The provider's behaviour after the enquiry is counted; the tests swap it.
  provider: null as null | (() => Promise<{ ok: boolean; score?: number; riskGrade?: string }>),
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => m.session.current) }))
vi.mock("@/lib/integrations/experian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/experian")>()),
  getCreditReport: vi.fn(async () => {
    m.enquiries += 1
    if (!m.provider) throw new Error("no provider stub")
    return m.provider()
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
const lockKey = () => `deal-bureau:${fx.tenantId}:${applicationId}:${fx.director}`
/** The director's CREDIT_BUREAU_CHECK records for this application written outside a failed enquiry's transaction. */
const unstoredEnquiries = () => database().complianceRecord.count({
  where: { tenantId: fx.tenantId, type: "CREDIT_BUREAU_CHECK", referenceId: applicationId, data: { path: ["enquiryMade"], equals: true } },
})
const attempts = () => database().complianceRecord.count({ where: { tenantId: fx.tenantId, type: "CREDIT_BUREAU_CHECK", referenceId: applicationId } })
const forced = () => runDealBureauCheck(fx.tenantId, applicationId, subject(), { force: true, startedAt: new Date() })

suite.sequential("bureau checks: one enquiry per person under concurrency (real Postgres)", () => {
  beforeAll(async () => {
    m.provider = slowReport
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

  it("does not reuse a recent check after the enquiry identity changes", async () => {
    m.enquiries = 0
    await database().client.update({ where: { id: fx.director }, data: { firstName: "Corrected" } })

    expect(await runDealBureauCheck(fx.tenantId, applicationId, subject(), { force: false, startedAt: new Date() })).toBe("stored")
    expect(m.enquiries).toBe(1)
  })

  it("a person's lock held elsewhere is waited for a bounded time: busy, no enquiry, nothing recorded", async () => {
    m.enquiries = 0
    const before = await attempts()
    let release = () => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    let held = () => {}
    const lockHeld = new Promise<void>((resolve) => { held = resolve })
    const holder = database().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey()}, 0))`
      held()
      await Promise.race([released, sleep(15_000)])
    }, { timeout: 30_000 })
    await lockHeld
    const began = Date.now()
    const outcome = await forced()
    const waited = Date.now() - began
    release()
    await holder
    expect(outcome).toBe("busy")
    expect(waited).toBeLessThan(10_000)
    expect(m.enquiries).toBe(0)
    expect(await attempts()).toBe(before)
  }, 40_000)

  it("the enquiry's transaction dies during a slow successful enquiry: the error surfaces and a record of the enquiry remains", async () => {
    m.enquiries = 0
    const [checks, unstored] = [await stored(), await unstoredEnquiries()]
    m.provider = async () => {
      // The connection holding this person's lock (the enquiry's transaction) is terminated mid-enquiry.
      // MATERIALIZED: the holder is chosen before any backend is terminated.
      const killed = await database().$queryRaw<Array<{ pid: number }>>`
        WITH holder AS MATERIALIZED (
          SELECT l."pid" FROM pg_locks l WHERE l."locktype" = 'advisory' AND l."granted" AND l."objsubid" = 1
            AND ((l."classid"::bigint << 32) | l."objid"::bigint) = hashtextextended(${lockKey()}, 0)
        )
        SELECT "pid" FROM holder WHERE pg_terminate_backend("pid")`
      expect(killed).toHaveLength(1)
      return slowReport()
    }
    try {
      await expect(forced()).rejects.toThrow()
    } finally {
      m.provider = slowReport
    }
    expect(m.enquiries).toBe(1)
    expect(await stored()).toBe(checks)
    expect(await unstoredEnquiries()).toBe(unstored + 1)
    const record = await database().complianceRecord.findFirstOrThrow({
      where: { tenantId: fx.tenantId, referenceId: applicationId, data: { path: ["enquiryMade"], equals: true } },
      orderBy: { createdAt: "desc" },
    })
    expect(record).toMatchObject({ status: "PENDING", completedAt: null })
    expect(record.data).toMatchObject({ provider: "experian", assetFinance: true, clientId: fx.director, outcome: "failed" })
    // The next run is not answered "recent" by it: the person is still unchecked.
    expect(await forced()).toBe("stored")
  }, 30_000)

  it("the database refuses the stored result of a slow successful enquiry: the error surfaces and a record of the enquiry remains", async () => {
    m.enquiries = 0
    const [checks, unstored] = [await stored(), await unstoredEnquiries()]
    // Postgres refuses U+0000 in text: the CreditBureauCheck insert fails after the enquiry.
    m.provider = async () => ({ ...(await slowReport()), riskGrade: "B\u0000" })
    try {
      await expect(forced()).rejects.toThrow()
    } finally {
      m.provider = slowReport
    }
    expect(m.enquiries).toBe(1)
    expect(await stored()).toBe(checks)
    expect(await unstoredEnquiries()).toBe(unstored + 1)
  }, 30_000)

  it("a simulated (dry-run) report keeps its marker on the stored check, so approval guards can refuse it", async () => {
    m.provider = async () => ({ ok: true, simulated: true, score: 645, riskGrade: "AVERAGE RISK" } as Report)
    try {
      expect(await forced()).toBe("stored")
    } finally {
      m.provider = slowReport
    }
    const row = await database().creditBureauCheck.findFirstOrThrow({
      where: { tenantId: fx.tenantId, applicationId, clientId: fx.director },
      orderBy: { createdAt: "desc" },
    })
    expect(row).toMatchObject({ provider: "experian", status: "OK", attempt: 1 })
    expect(row.obligations).toMatchObject({ simulated: true, simulationSource: "experian" })
  }, 30_000)
})
