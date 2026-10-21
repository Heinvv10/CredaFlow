/**
 * Guide flows (review repro, PR #229): supersede on the same effective date,
 * older-than-current, discard then reload, and lookup normalisation, against
 * real Postgres.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/edge-flows.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupDealFixture, createDealFixture, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { cleanupGuides, day, today } from "./guide.integration-fixture"
import * as store from "./guide-store"
import { guideCandidates } from "./lookup"
import { csvGuideProvider } from "./providers/csv-guide"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const csv = (...lines: string[]) => new TextEncoder().encode(["make,model,year,variant,trade_cents,retail_cents", ...lines].join("\n") + "\n")
let fx: DealFixture
const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(fx.tenantId, fn)
const createDraftGuide = (...a: Parameters<typeof store.createDraftGuide>) => inTenant(() => store.createDraftGuide(...a))
const publishGuide = (...a: Parameters<typeof store.publishGuide>) => inTenant(() => store.publishGuide(...a))
const discardGuide = (...a: Parameters<typeof store.discardGuide>) => inTenant(() => store.discardGuide(...a))
const A = () => ({ tenantId: fx.tenantId, userId: fx.adminA, userEmail: "a@example.test" })
const B = () => ({ tenantId: fx.tenantId, userId: fx.adminB, userEmail: "b@example.test" })
const load = async (name: string, effectiveOn: string, ...lines: string[]) => {
  const r = await createDraftGuide(A(), { name, effectiveOn, provider: csvGuideProvider, bytes: csv(...lines) })
  if (r.kind !== "created") throw new Error(`not created: ${r.kind}`)
  return r.guide.id
}

suite("guide flows: edge cases", () => {
  beforeAll(async () => { fx = await createDealFixture(db as PrismaClient, t, { templates: false }) })
  afterAll(async () => {
    await cleanupGuides(db as PrismaClient, fx.tenantId)
    await cleanupDealFixture(db as PrismaClient, fx)
    await db?.$disconnect()
  })

  it("a guide dated the same day supersedes the current one of that name (name case ignored)", async () => {
    const first = await load("TEST Same Day", day(-3), "TEST,EX-1,2025,,10,20")
    expect((await publishGuide(B(), first)).kind).toBe("published")
    const second = await load("test same day", day(-3), "TEST,EX-1,2025,,11,21")
    const r = await publishGuide(B(), second)
    expect(r).toMatchObject({ kind: "published", superseded: first })
  })

  it("an older-dated guide cannot supersede a newer current guide, but can be discarded and its file loaded again", async () => {
    const cur = await load("TEST Older", day(-1), "TEST,EX-1,2025,,13,23")
    await publishGuide(B(), cur)
    const bytes = csv("TEST,EX-1,2025,,12,22")
    const old = await createDraftGuide(A(), { name: "TEST Older", effectiveOn: day(-9), provider: csvGuideProvider, bytes })
    if (old.kind !== "created") throw new Error(old.kind)
    expect((await publishGuide(B(), old.guide.id)).kind).toBe("older_than_current")
    expect((await discardGuide(B(), old.guide.id)).kind).toBe("discarded")
    expect((await createDraftGuide(A(), { name: "TEST Older", effectiveOn: day(-9), provider: csvGuideProvider, bytes })).kind).toBe("created")
  })

  it("a future-dated draft cannot be published, and a discarded guide cannot be published", async () => {
    const future = await load("TEST Future", day(1), "TEST,EX-1,2025,,14,24")
    expect((await publishGuide(B(), future)).kind).toBe("not_yet_effective")
    await discardGuide(A(), future)
    expect((await publishGuide(B(), future)).kind).toBe("not_draft")
  })

  it("lookup matches the asset by trimmed, case-folded make and model, not by inner whitespace", async () => {
    const id = await load("TEST Lookup", day(-1), "Caterpillar,320 GC,2025,,10,20", "Land Cruiser,79,2025,,10,20")
    await publishGuide(B(), id)
    const find = async (make: string, model: string) =>
      (await guideCandidates(db as PrismaClient as never, fx.tenantId, { make, model, year: 2025 }, today())).filter((c) => c.guideId === id).length
    expect(await find("  CATERPILLAR ", "320 gc")).toBe(1)
    // By design (SLICE5.md Part C, known limitations): only case and outer spaces are ignored, not inner whitespace.
    expect(await find("Caterpillar", "320  GC")).toBe(0)
  })
})
