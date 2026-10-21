/**
 * Breaker round 2 repro for PR #229, kept as a regression: the database dated
 * a supersede with now(), the transaction's start time, so a publish whose
 * transaction began just before another publish of that name committed
 * superseded a guide published "after" it began, and ValuationGuide_times
 * (supersededAt >= publishedAt) refused a legitimate move. The guard now
 * dates moves with clock_timestamp() (migration 20261021090300).
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-breaker-r2.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { cleanupGuides, day, draftGuide, publishGuideRow, supersedeGuideRow } from "./guide.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_VALUATION_IT=1 is required")
  return db
}
let fx: DealFixture

suite("valuation guide breaker round 2", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t, { templates: false })
  }, 300_000)

  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, { tenantId: dealFixtureTenantId(t) }).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("R2-1: a publish whose transaction began before the current guide was published can still supersede it", async () => {
    const name = `TEST Clock ${t}`
    const first = await draftGuide(database(), fx.tenantId, fx.adminA, { name, effectiveOn: day(-3) })
    const second = await draftGuide(database(), fx.tenantId, fx.adminA, { name, effectiveOn: day(-1) })
    let go!: () => void
    const firstCommitted = new Promise<void>((r) => { go = r })
    // T2 opens (now() is fixed here), then waits until T1 has published `first`.
    const t2 = database().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`
      await firstCommitted
      await supersedeGuideRow(tx, first.id, second.id)
      await publishGuideRow(tx, second.id, fx.adminB)
    }, { timeout: 30_000 }).then(() => "ok", (e: unknown) => (e as Error).message.split("\n").slice(-3).join(" "))
    await new Promise((r) => setTimeout(r, 200))
    await publishGuideRow(database(), first.id, fx.adminB)
    go()
    expect(await t2).toBe("ok")
  })
})
