/**
 * The read side against real Postgres (review round 1, PR #229): the
 * candidates for an asset are its own make, model and year only; the Guide
 * value panel and the recovery's guide reference read the asset's NEWEST
 * guide value, in the lender's own tenant, with LTV against trade and retail
 * and the simulated label. (RecoveryPanel.test.tsx and the panel test mock
 * these loaders; this runs them.)
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/loaders.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { loadGuideReference } from "@/components/asset-finance/recovery/recovery-panel-data"
import { prisma } from "@/lib/prisma"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { cleanupGuides, day, guideValuationData, publishedGuide, today, type GuideRowSeed } from "./guide.integration-fixture"
import { loadGuidePanel } from "./guide-panel"
import { guideCandidates, latestGuideValuation } from "./lookup"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const t2 = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_VALUATION_IT=1 is required")
  return db
}
/** fx.assets[0] is TEST EX-1 2025. Two rows are its own; each other row differs in make, year or model. */
const ROWS: GuideRowSeed[] = [
  { make: "TEST", model: "EX-1", year: 2025, variant: "", tradeCents: 120_000_000, retailCents: 140_000_000 },
  { make: "TEST", model: "EX-1", year: 2025, variant: "Long reach", tradeCents: 125_000_000, retailCents: 150_000_000 },
  { make: "OTHER", model: "EX-1", year: 2025, variant: "", tradeCents: 1, retailCents: 2 },
  { make: "TEST", model: "EX-1", year: 2024, variant: "", tradeCents: 3, retailCents: 4 },
  { make: "TEST", model: "EX-9", year: 2025, variant: "", tradeCents: 5, retailCents: 6 },
]
const SIMULATED: GuideRowSeed[] = [{ make: "TEST", model: "EX-1", year: 2025, variant: "Sim", tradeCents: 100_000_000, retailCents: 160_000_000 }]
let fx: DealFixture
let other: DealFixture
let guide: { id: string; rowIds: string[] }
let simulated: { id: string; rowIds: string[] }

suite("guide loaders (real Postgres)", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t, { templates: false })
    other = await createDealFixture(database(), t2, { templates: false })
    guide = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { effectiveOn: day(-3), rows: ROWS })
    simulated = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { name: "TEST Simulated Guide", effectiveOn: day(-3), rows: SIMULATED, simulated: true })
    // Another lender's current guide with a row for the same make, model and year.
    await publishedGuide(database(), other.tenantId, other.adminA, other.adminB, {
      effectiveOn: day(-3), rows: [{ make: "TEST", model: "EX-1", year: 2025, variant: "Foreign", tradeCents: 7, retailCents: 8 }],
    })
    // Two guide values on the asset: "Long reach" first, then the simulated row (the newest).
    await database().assetValuation.create({ data: guideValuationData(fx.tenantId, fx.assets[0], guide.id, guide.rowIds[1], ROWS[1].tradeCents, fx.officer) })
    await database().assetValuation.create({ data: guideValuationData(fx.tenantId, fx.assets[0], simulated.id, simulated.rowIds[0], SIMULATED[0].tradeCents, fx.officer) })
  }, 300_000)

  afterAll(async () => {
    if (!db) return
    for (const [f, token] of [[fx, t], [other, t2]] as const) {
      const tenantId = f?.tenantId ?? dealFixtureTenantId(token)
      await cleanupGuides(db, tenantId).catch(() => undefined)
      await cleanupDealFixture(db, f ?? { tenantId })
    }
    await db.$disconnect()
  })

  it("offers only the lender's own rows of the asset's own make, model and year", async () => {
    const rows = await guideCandidates(prisma, fx.tenantId, { make: " test ", model: "ex-1", year: 2025 }, today())
    expect(rows.map((r) => `${r.make}/${r.year}/${r.variant}`).sort()).toEqual(["TEST/2025/", "TEST/2025/Long reach", "TEST/2025/Sim"])
  })

  it("reads the asset's newest guide value, in the lender's own tenant only", async () => {
    expect(await latestGuideValuation(prisma, fx.tenantId, fx.assets[0])).toMatchObject({ amountCents: 100_000_000, snapshot: { variant: "Sim", simulated: true } })
    expect(await latestGuideValuation(prisma, other.tenantId, fx.assets[0])).toBeNull()
  })

  it("gives the panel the newest value and the advance's LTV against its trade and retail values", async () => {
    const panel = await loadGuidePanel(fx.tenantId, fx.assets[0], 150_000_000)
    expect(panel?.latest?.snapshot).toMatchObject({ variant: "Sim", tradeCents: 100_000_000, retailCents: 160_000_000 })
    expect(panel?.advance).toEqual({ cents: 150_000_000, tradeLtvBps: 15_000, retailLtvBps: 9_375 })
    expect(panel?.candidates).toHaveLength(3)
    expect(await loadGuidePanel(other.tenantId, fx.assets[0], 150_000_000)).toBeNull()
  })

  it("gives the recovery its newest guide value as a labelled reference", async () => {
    const reference = await loadGuideReference(fx.tenantId, fx.assets[0])
    expect(reference).toMatch(/^R\s?1[\s,]000[\s,]000\.00 trade, R\s?1[\s,]600[\s,]000\.00 retail · TEST Simulated Guide \(simulated\), effective /)
    expect(await loadGuideReference(other.tenantId, fx.assets[0])).toBeNull()
  })
})
