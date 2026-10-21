/**
 * Slice 5 part C: a GUIDE valuation (migration 20261021090100), each rule
 * proved as in the slice 4 suites (refused; with that one clause, CHECK or
 * trigger out, admitted, inside a rolled-back transaction). A GUIDE row names
 * a guide and one of its rows, and only a GUIDE row does; the guide is
 * PUBLISHED, in force, and the lender's own (a composite FK backs the
 * trigger); the row is for the asset's make, model and year; it is dated the
 * day it is read, at the row's trade value; the database writes the snapshot.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-valuation.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "@/lib/asset-finance/dates"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { raiseOff, rules, triggersOff, type Tx } from "@/lib/asset-finance/recovery-rules.integration-fixture"
import { attempt } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { EX1_ROWS, cleanupGuides, day, draftGuide, guideValuationData, publishedGuide, publishGuideRow, supersedeGuideRow } from "./guide.integration-fixture"

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
const { refuses, admits } = rules(database)
const V = "guardAssetValuationGuide"
const GUIDE_TRIGGER = { table: "AssetValuation", trigger: "AssetValuation_guide_guard" }
const SHAPE = { table: "AssetValuation", constraint: "AssetValuation_guide_shape" }
const IN_FORCE = "A guide valuation reads a published guide in force on its date"
const MATCH = "A guide valuation reads a row for the asset's make, model and year"
const AMOUNT = "A guide valuation's amount is the row's trade value"
let fx: DealFixture
let other: DealFixture
/** live: published, rows EX1_ROWS; draft; old: superseded by live2; foreign: the other lender's. */
const g = { live: { id: "", rowIds: [] as string[] }, draft: { id: "", rowIds: [] as string[] }, old: { id: "", rowIds: [] as string[] }, foreign: { id: "", rowIds: [] as string[] } }

const value = (tx: Tx, guide: { id: string; rowIds: string[] }, row = 0, over: Record<string, unknown> = {}) =>
  tx.assetValuation.create({ data: guideValuationData(fx.tenantId, fx.assets[0], guide.id, guide.rowIds[row], EX1_ROWS[row].tradeCents, fx.officer, over) as never })

suite("GUIDE valuation database rules", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t, { templates: false })
    other = await createDealFixture(database(), t2, { templates: false })
    g.live = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { effectiveOn: day(-5) })
    g.draft = await draftGuide(database(), fx.tenantId, fx.adminA, { name: "TEST Draft Guide" })
    g.old = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { name: "TEST Old Guide", effectiveOn: day(-30) })
    const successor = await draftGuide(database(), fx.tenantId, fx.adminA, { name: "TEST Old Guide", effectiveOn: day(-2) })
    await database().$transaction(async (tx) => {
      await supersedeGuideRow(tx, g.old.id, successor.id)
      await publishGuideRow(tx, successor.id, fx.adminB)
    })
    g.foreign = await publishedGuide(database(), other.tenantId, other.adminA, other.adminB, { effectiveOn: day(-5) })
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

  it("records a published guide's row as the asset's GUIDE valuation, with the database's snapshot", async () => {
    const row = await database().assetValuation.create({ data: guideValuationData(fx.tenantId, fx.assets[0], g.live.id, g.live.rowIds[1], EX1_ROWS[1].tradeCents, fx.officer) })
    const stored = await database().assetValuation.findUniqueOrThrow({ where: { id: row.id } })
    expect(stored.amountCents).toBe(EX1_ROWS[1].tradeCents)
    expect(stored.guideSnapshot).toMatchObject({
      guideId: g.live.id, guideName: "TEST Plant Guide", effectiveOn: day(-5), provider: "csv", simulated: false,
      rowId: g.live.rowIds[1], lineNumber: 3, make: "TEST", model: "EX-1", year: 2025, variant: "Long reach",
      tradeCents: EX1_ROWS[1].tradeCents, retailCents: EX1_ROWS[1].retailCents,
    })
  })

  it("is a GUIDE row exactly when it names a guide, a row and a snapshot", async () => {
    // The trigger reads a GUIDE row's guide first: off, the CHECK is shown to refuse on its own.
    await refuses(SHAPE, /AssetValuation_guide_shape/, async (tx) => {
      await triggersOff(tx)
      await value(tx, g.live, 0, { guideId: null, guideRowId: null })
    })
    await refuses(SHAPE, /AssetValuation_guide_shape/, (tx) => value(tx, g.live, 0, { source: "DEALER" }))
  })

  it("never takes a snapshot from the caller", async () => {
    await refuses(raiseOff(V, "A guide valuation's snapshot is written by the database"), /snapshot is written by the database/,
      (tx) => value(tx, g.live, 0, { guideSnapshot: { tradeCents: 999 } }))
  })

  it("reads a published guide in force, never a draft or a superseded one", async () => {
    await refuses(raiseOff(V, IN_FORCE), /published guide in force/, (tx) => value(tx, g.draft))
    await refuses(raiseOff(V, IN_FORCE), /published guide in force/, (tx) => value(tx, g.old))
  })

  it("is dated the day it is read", async () => {
    await refuses(raiseOff(V, "A guide valuation is dated the day it is read"), /dated the day it is read/,
      (tx) => value(tx, g.live, 0, { valuedOn: dbDate(day(-1)) }))
  })

  it("reads a row for the asset's make, model and year, at its trade value", async () => {
    // fx.assets[1] is an EX-2; the row is an EX-1.
    await refuses(raiseOff(V, MATCH), /make, model and year/, (tx) => value(tx, g.live, 0, { assetId: fx.assets[1] }))
    await refuses(raiseOff(V, AMOUNT), /row's trade value/,
      (tx) => value(tx, g.live, 0, { amountCents: EX1_ROWS[0].retailCents }))
  })

  it("names a row of its own guide: the trigger refuses, and the composite FK behind it", async () => {
    // A row of another guide (same tenant), under the live guide's id.
    const crossed = (tx: Tx) => value(tx, g.live, 0, { guideRowId: g.old.rowIds[0] })
    // Without the row it reads there is no trade value to compare either: that clause goes too.
    await refuses(raiseOff(V, MATCH), /make, model and year/, crossed, [
      raiseOff(V, AMOUNT), { table: "AssetValuation", constraint: "AssetValuation_tenantId_guideId_guideRowId_fkey" },
    ])
    // With the trigger off (so the caller supplies the snapshot), the composite FK still refuses it.
    const crossedRaw = (tx: Tx) => value(tx, g.live, 0, { guideRowId: g.old.rowIds[0], guideSnapshot: {} })
    expect(await attempt(database(), crossedRaw, GUIDE_TRIGGER)).toMatch(/AssetValuation_tenantId_guideId_guideRowId_fkey/)
  })

  it("never reads another lender's guide: the trigger refuses, and the tenant FK behind it", async () => {
    const foreign = (tx: Tx) => value(tx, g.foreign)
    await refuses(raiseOff(V, IN_FORCE), /published guide in force/, foreign, [
      raiseOff(V, MATCH), raiseOff(V, AMOUNT),
      { table: "AssetValuation", constraint: "AssetValuation_tenantId_guideId_fkey" },
      { table: "AssetValuation", constraint: "AssetValuation_tenantId_guideId_guideRowId_fkey" },
    ])
    expect(await attempt(database(), (tx) => value(tx, g.foreign, 0, { guideSnapshot: {} }), GUIDE_TRIGGER)).toMatch(/AssetValuation_tenantId_guideId_(guideRowId_)?fkey/)
  })

  it("leaves every other source alone", async () => {
    await admits((tx) => tx.assetValuation.create({
      data: { tenantId: fx.tenantId, assetId: fx.assets[0], valuedOn: dbDate(day(-3)), source: "ASSESSOR", valuerName: "TEST Assessors", amountCents: 1, createdById: fx.adminA },
    }))
  })
})
