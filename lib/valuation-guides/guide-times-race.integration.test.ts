/**
 * Review repro (PR #229 round 2, arch), kept as a regression: guardValuationGuide
 * dated each move with now(), the transaction's START time, so a publish
 * transaction that began before another transaction published the current
 * guide of that name stamped supersededAt earlier than that guide's
 * publishedAt, and ValuationGuide_times refused the supersede. The guard now
 * dates moves with clock_timestamp() (migration 20261021090300).
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 npx vitest run lib/valuation-guides/guide-times-race.integration.test.ts
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
let fx: DealFixture

suite("guide move times use the clock, not the transaction's start", () => {
  beforeAll(async () => {
    fx = await createDealFixture(db!, t, { templates: false })
  }, 300_000)
  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, { tenantId: dealFixtureTenantId(t) }).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("a publish transaction older than the current guide's publish still supersedes it", async () => {
    const a = await draftGuide(db!, fx.tenantId, fx.adminA, { name: "TIMES Guide", effectiveOn: day(-2) })
    const b = await draftGuide(db!, fx.tenantId, fx.adminA, { name: "TIMES Guide", effectiveOn: day(-1) })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let started!: () => void
    const began = new Promise<void>((r) => { started = r })
    const older = db!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT now()` // the transaction has begun: now() is fixed from here
      started()
      await gate
      await supersedeGuideRow(tx, a.id, b.id)
      await publishGuideRow(tx, b.id, fx.adminB)
    }, { timeout: 30_000 }).then(() => "ok", (e: Error) => e.message)
    await began
    await new Promise((r) => setTimeout(r, 50))
    await publishGuideRow(db!, a.id, fx.adminB) // a newer transaction puts A live
    release()
    expect(await older).toBe("ok")
  })
})
