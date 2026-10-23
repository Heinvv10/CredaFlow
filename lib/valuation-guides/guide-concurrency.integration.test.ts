/**
 * The two unique-index race branches of guide-store.ts (concurrent_publish,
 * duplicate_file via P2002): one winner, the other a refusal, never a 500.
 * (Review repro, PR #229.)
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=... npx vitest run lib/valuation-guides/guide-concurrency.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { cleanupGuides, day, draftGuide } from "./guide.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { createDraftGuide, publishGuide } from "./guide-store"
import { csvGuideProvider } from "./providers/csv-guide"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealFixture

suite("guide-store races", () => {
  beforeAll(async () => {
    if (!db) return
    fx = await createDealFixture(db, t, { templates: false })
  }, 300_000)
  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, { tenantId: dealFixtureTenantId(t) }).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("two drafts of one name published at once: one wins, the other is concurrent_publish", async () => {
    const a = await draftGuide(db!, fx.tenantId, fx.adminA, { name: "RACE Guide", effectiveOn: day(-1) })
    const b = await draftGuide(db!, fx.tenantId, fx.adminA, { name: "RACE Guide", effectiveOn: day(-1) })
    const actor = { tenantId: fx.tenantId, userId: fx.adminB, userEmail: "b@staff.invalid" }
    const results = await Promise.all([runWithTenant(fx.tenantId, () => publishGuide(actor, a.id)), runWithTenant(fx.tenantId, () => publishGuide(actor, b.id))])
    expect(results.map((r) => r.kind).sort()).toEqual(["concurrent_publish", "published"])
  })

  it("the same bytes loaded at once: one created, the other duplicate_file", async () => {
    const bytes = new TextEncoder().encode("make,model,year,variant,trade_cents,retail_cents\nRACE,X,2025,,1,2\n")
    const actor = { tenantId: fx.tenantId, userId: fx.adminA, userEmail: "a@staff.invalid" }
    const load = () => createDraftGuide(actor, { name: `RACE ${randomUUID().slice(0, 6)}`, effectiveOn: "2026-01-01", provider: csvGuideProvider, bytes })
    const results = await Promise.all([runWithTenant(fx.tenantId, load), runWithTenant(fx.tenantId, load)])
    expect(results.map((r) => r.kind).sort()).toEqual(["created", "duplicate_file"])
  })
})
