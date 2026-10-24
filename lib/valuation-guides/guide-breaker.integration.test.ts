/**
 * Breaker repros for PR #229 (valuation guides), kept as regressions. Each
 * case asserts the rule the spec states. B1–B4 were holes on 5e251bdb, fixed
 * by migration 20261021090300 and guide-store.ts; B5–B7 held.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-breaker.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { attempt } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { cleanupGuides, draftGuide, day, freshSha, publishedGuide, publishGuideRow, supersedeGuideRow } from "./guide.integration-fixture"
import { createDraftGuide, publishGuide } from "./guide-store"
import { csvGuideProvider } from "./providers/csv-guide"
import { runWithTenant } from "@/lib/tenant-scope"

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
const actor = (userId: string) => ({ tenantId: fx.tenantId, userId, userEmail: `${userId}@staff.invalid` })
const published = (name: string) => database().valuationGuide.count({ where: { tenantId: fx.tenantId, status: "PUBLISHED", name } })

suite("valuation guide breaker repros", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t, { templates: false })
  }, 300_000)

  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, { tenantId: dealFixtureTenantId(t) }).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("B1: a guide is never taken down without a published replacement (equal-dated mutual supersede)", async () => {
    const name = `TEST Cycle ${t}`
    const a = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { name, effectiveOn: day(-5) })
    const b = await draftGuide(database(), fx.tenantId, fx.adminA, { name, effectiveOn: day(-5) })
    await database().$transaction(async (tx) => {
      await supersedeGuideRow(tx, a.id, b.id)
      await publishGuideRow(tx, b.id, fx.adminB)
    })
    expect(await published(name)).toBe(1)
    // Take B down, naming the already-superseded A (same name, same date) as its "successor".
    const result = await attempt(database(), (tx) => supersedeGuideRow(tx, b.id, a.id))
    expect(result).not.toBe("ok")
  })

  it("B2: a synthetic-provider guide is always stored simulated", async () => {
    const result = await attempt(database(), (tx) => tx.valuationGuide.create({ data: {
      tenantId: fx.tenantId, name: `TEST Synth ${t}`, effectiveOn: new Date(day(-1)), provider: "synthetic", simulated: false,
      fileSha256: freshSha(), rowCount: 1, uploadedById: fx.adminA,
    } }))
    expect(result).not.toBe("ok")
  })

  it("B3: publishedAt is the database's time, never the caller's", async () => {
    const g = await draftGuide(database(), fx.tenantId, fx.adminA, { name: `TEST Backdate ${t}`, effectiveOn: day(-1) })
    await database().valuationGuide.update({ where: { id: g.id }, data: { status: "PUBLISHED", publishedById: fx.adminB, publishedAt: new Date("2001-01-01T00:00:00Z") } })
    const stored = await database().valuationGuide.findUniqueOrThrow({ where: { id: g.id } })
    expect(stored.publishedAt!.getTime()).toBeGreaterThanOrEqual(stored.uploadedAt.getTime())
    expect(Date.now() - stored.publishedAt!.getTime()).toBeLessThan(60_000)
  })

  it("B4: a guide whose make differs from another only in a final sigma is refused cleanly, not a 500", async () => {
    const csv = "make,model,year,variant,trade_cents,retail_cents\nΟΣ,EX-1,2025,,100,200\nοσ,EX-1,2025,,100,200\n"
    const out = await runWithTenant(fx.tenantId, () => createDraftGuide(actor(fx.adminA), { name: `TEST Sigma ${t}`, effectiveOn: day(-1), provider: csvGuideProvider, bytes: new TextEncoder().encode(csv) }))
      .then((r) => r.kind, (e: unknown) => `threw: ${(e as Error).message.split("\n").slice(-2).join(" ")}`)
    expect(out).toBe("refused")
  })

  it("B5: concurrent publishes of two drafts over one current guide leave exactly one PUBLISHED", async () => {
    const name = `TEST Race ${t}`
    await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { name, effectiveOn: day(-10) })
    const d1 = await draftGuide(database(), fx.tenantId, fx.adminA, { name, effectiveOn: day(-2) })
    const d2 = await draftGuide(database(), fx.tenantId, fx.adminA, { name, effectiveOn: day(-1) })
    const kinds = await Promise.all([runWithTenant(fx.tenantId, () => publishGuide(actor(fx.adminB), d1.id)), runWithTenant(fx.tenantId, () => publishGuide(actor(fx.adminB), d2.id))].map((p) => p.then((r) => r.kind, (e: unknown) => `threw: ${(e as Error).message.slice(0, 200)}`)))
    expect(kinds.every((k) => k === "published" || k === "concurrent_publish" || k === "older_than_current")).toBe(true)
    // Overlapping, one wins and the other is concurrent_publish. A slow runner can serialise the two calls: then the
    // later-dated draft ends current either way (d1 then d2: both published, d1 superseded by d2; d2 then d1: d1 is
    // older_than_current and stays a draft). Either way exactly one is current.
    if (kinds.includes("concurrent_publish")) expect(kinds.filter((k) => k === "published")).toHaveLength(1)
    else {
      const guide = (id: string) => database().valuationGuide.findUniqueOrThrow({ where: { id } })
      expect((await guide(d2.id)).status).toBe("PUBLISHED")
      const first = await guide(d1.id)
      expect(kinds[0] === "published" ? [first.status, first.supersededById] : [first.status]).toEqual(kinds[0] === "published" ? ["SUPERSEDED", d2.id] : ["DRAFT"])
    }
    expect(await published(name)).toBe(1)
  })

  it("B6: a row inserted while a publish is in flight never lands in the published guide", async () => {
    const g = await draftGuide(database(), fx.tenantId, fx.adminA, { name: `TEST RowRace ${t}`, effectiveOn: day(-1) })
    const rows0 = await database().valuationGuideRow.count({ where: { guideId: g.id } })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const pub = database().$transaction(async (tx) => {
      await publishGuideRow(tx, g.id, fx.adminB)
      await gate
    })
    await new Promise((r) => setTimeout(r, 300))
    const insert = database().valuationGuideRow.create({ data: { tenantId: fx.tenantId, guideId: g.id, lineNumber: 99, make: "TEST", model: "LATE", year: 2025, tradeCents: 1, retailCents: 1 } })
      .then(() => "inserted", (e: unknown) => (e as Error).message.includes("Rows are added to a DRAFT guide only") ? "refused" : `other: ${(e as Error).message.slice(0, 200)}`)
    await new Promise((r) => setTimeout(r, 300))
    release()
    await pub
    expect(await insert).toBe("refused")
    expect(await database().valuationGuideRow.count({ where: { guideId: g.id } })).toBe(rows0)
  })
})

suite("valuation guide breaker repros: size", () => {
  const t2 = randomUUID().replaceAll("-", "").slice(0, 16)
  let fx2: DealFixture
  beforeAll(async () => { fx2 = await createDealFixture(database(), t2, { templates: false }) }, 300_000)
  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx2?.tenantId ?? dealFixtureTenantId(t2)).catch(() => undefined)
    await cleanupDealFixture(db, { tenantId: dealFixtureTenantId(t2) }).catch(() => undefined)
  }, 120_000)

  it("B7: a 20 000-row guide (the documented maximum) loads", async () => {
    const lines = ["make,model,year,variant,trade_cents,retail_cents"]
    for (let i = 0; i < 20_000; i++) lines.push(`TEST,M${i},2025,,100,200`)
    const out = await runWithTenant(fx2.tenantId, () => createDraftGuide({ tenantId: fx2.tenantId, userId: fx2.adminA, userEmail: "a@staff.invalid" },
      { name: `TEST Big ${t2}`, effectiveOn: day(-1), provider: csvGuideProvider, bytes: new TextEncoder().encode(lines.join("\n")) }))
      .then((r) => r.kind, (e: unknown) => `threw: ${(e as Error).message.slice(-300)}`)
    expect(out).toBe("created")
  }, 120_000)
})
