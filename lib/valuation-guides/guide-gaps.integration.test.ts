/**
 * Valuation-guide rules the first suites did not kill (review repros, PR #229,
 * extended in fix round 1). Each attack is refused and goes through with that
 * one clause, CHECK, index, trigger or allow-list entry out (the slice 4
 * `refuses` proof).
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-gaps.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "@/lib/asset-finance/dates"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { clauseOff, raiseOff, rules, triggersOff, type Tx } from "@/lib/asset-finance/recovery-rules.integration-fixture"
import { attempt } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { cleanupGuides, day, draftGuide, freshSha, guideValuationData, publishedGuide, publishGuideRow } from "./guide.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_VALUATION_IT=1 is required")
  return db
}
const { refuses, admits } = rules(database)
const G = "guardValuationGuide"
const V = "guardAssetValuationGuide"
const MOVES_ONLY = /changes only its status and who moved it/
let fx: DealFixture

const draft = (tx: Tx, o: Parameters<typeof draftGuide>[3] = {}) => draftGuide(tx, fx.tenantId, fx.adminA, { name: `TEST Gap ${randomUUID().slice(0, 8)}`, ...o })
const rawGuide = (tx: Tx, over: Record<string, unknown>) => {
  const v = { name: "TEST Raw", provider: "csv", sha: freshSha(), rowCount: 1, publishedById: null, publishedAt: null, ...over }
  return tx.$executeRawUnsafe(
    `INSERT INTO "ValuationGuide" ("id", "tenantId", "name", "effectiveOn", "provider", "fileSha256", "rowCount", "uploadedById", "publishedById", "publishedAt")
     VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8, $9)`,
    `vg_${randomUUID()}`, fx.tenantId, v.name, v.provider, v.sha, v.rowCount, fx.adminA, v.publishedById, v.publishedAt,
  )
}

suite("PR #229 part C: guard clauses no suite killed", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t, { templates: false })
  }, 300_000)

  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("never supersedes a guide by itself: that would take it down with no replacement", async () => {
    await refuses(clauseOff(G, `AND g."id" <> NEW."id"`), /same name dated on or after it/, async (tx) => {
      const { id } = await publishedGuide(tx, fx.tenantId, fx.adminA, fx.adminB, { name: `TEST Self ${randomUUID().slice(0, 8)}`, effectiveOn: day(-2) })
      await tx.valuationGuide.update({ where: { id }, data: { status: "SUPERSEDED", supersededById: id, supersededAt: new Date() } })
    }, [
      // A guide is also refused as its own successor because it is not a DRAFT, and at commit: both out, so this clause shows alone.
      clauseOff(G, `AND g."status" = 'DRAFT'`), { table: "ValuationGuide", trigger: "ValuationGuide_successor_published" },
    ])
  })

  it("lets a move change only its own columns: publishing cannot rewrite who loaded it, the source or the simulated flag", async () => {
    const publishWide = clauseOff(G, `ARRAY['status', 'publishedById', 'publishedAt']`,
      `ARRAY['status', 'publishedById', 'publishedAt', 'uploadedById', 'uploadedAt', 'provider', 'simulated', 'fileSha256', 'effectiveOn']`)
    for (const data of [{ uploadedById: fx.officer }, { uploadedAt: new Date(0) }, { provider: "synthetic" }, { simulated: false }, { fileSha256: freshSha() }, { effectiveOn: dbDate(day(-1)) }]) {
      await refuses(publishWide, MOVES_ONLY, async (tx) => {
        const { id } = await draft(tx, { simulated: true, effectiveOn: day(-3) })
        await tx.valuationGuide.update({ where: { id }, data: { status: "PUBLISHED", publishedById: fx.adminB, publishedAt: new Date(), ...data } })
      })
    }
    const discardWide = clauseOff(G, `ARRAY['status', 'discardedById', 'discardedAt']`, `ARRAY['status', 'discardedById', 'discardedAt', 'name', 'fileSha256', 'rowCount']`)
    for (const data of [{ name: "TEST Renamed" }, { fileSha256: freshSha() }]) {
      await refuses(discardWide, MOVES_ONLY, async (tx) => {
        const { id } = await draft(tx)
        await tx.valuationGuide.update({ where: { id }, data: { status: "DISCARDED", discardedById: fx.adminA, discardedAt: new Date(), ...data } })
      })
    }
    const supersedeWide = clauseOff(G, `ARRAY['status', 'supersededById', 'supersededAt']`, `ARRAY['status', 'supersededById', 'supersededAt', 'publishedById', 'publishedAt']`)
    await refuses(supersedeWide, MOVES_ONLY, async (tx) => {
      const name = `TEST Chain ${randomUUID().slice(0, 8)}`
      const old = await publishedGuide(tx, fx.tenantId, fx.adminA, fx.adminB, { name, effectiveOn: day(-5) })
      const next = await draft(tx, { name, effectiveOn: day(-1) })
      await tx.valuationGuide.update({ where: { id: old.id }, data: { status: "SUPERSEDED", supersededById: next.id, supersededAt: new Date(), publishedById: fx.officer } })
      await publishGuideRow(tx, next.id, fx.adminB)
    })
  })

  it("holds a guide to its name, source, hash, row count and status shape (CHECKs)", async () => {
    const on = (constraint: string) => ({ table: "ValuationGuide", constraint })
    await refuses(on("ValuationGuide_name"), /ValuationGuide_name/, (tx) => rawGuide(tx, { name: " padded " }))
    await refuses(on("ValuationGuide_provider"), /ValuationGuide_provider/, (tx) => rawGuide(tx, { provider: "Bad Provider" }))
    await refuses(on("ValuationGuide_sha256"), /ValuationGuide_sha256/, (tx) => rawGuide(tx, { sha: "xyz" }))
    await refuses(on("ValuationGuide_row_count"), /ValuationGuide_row_count/, (tx) => rawGuide(tx, { rowCount: 0 }))
    // The guard dates the upload by the clock, after this publish time: the times CHECK out too.
    await refuses(on("ValuationGuide_status_shape"), /ValuationGuide_status_shape/, (tx) => rawGuide(tx, { publishedById: fx.adminB, publishedAt: new Date() }),
      [on("ValuationGuide_times")])
  })

  it("holds a row's line number to one row (ValuationGuideRow_line_key)", async () => {
    await refuses({ index: "ValuationGuideRow_line_key" }, /ValuationGuideRow_line_key/, async (tx) => {
      const { id } = await draft(tx, { rows: [] , rowCount: 2 })
      for (const model of ["EX-A", "EX-B"]) {
        await tx.valuationGuideRow.create({ data: { tenantId: fx.tenantId, guideId: id, lineNumber: 2, make: "TEST", model, year: 2025, tradeCents: 1, retailCents: 2 } })
      }
    })
  })

  it("reads a row of the asset's own make and year, not only its model", async () => {
    // fx.assets[0] is TEST EX-1 2025.
    const wrong = async (tx: Tx, row: { make: string; year: number }) => {
      const guide = await publishedGuide(tx, fx.tenantId, fx.adminA, fx.adminB, {
        name: `TEST Wrong ${randomUUID().slice(0, 8)}`, rows: [{ model: "EX-1", tradeCents: 100, retailCents: 200, ...row }],
      })
      await tx.assetValuation.create({ data: guideValuationData(fx.tenantId, fx.assets[0], guide.id, guide.rowIds[0], 100, fx.officer) as never })
    }
    await refuses(clauseOff(V, `lower(btrim(asset."make")) IS DISTINCT FROM lower(guide_row."make")`, "FALSE"), /make, model and year/,
      (tx) => wrong(tx, { make: "OTHER", year: 2025 }))
    await refuses(clauseOff(V, `OR asset."year" IS DISTINCT FROM guide_row."year"`), /make, model and year/,
      (tx) => wrong(tx, { make: "TEST", year: 2024 }))
  })

  it("snapshots whether the guide was simulated, so the label follows the value", async () => {
    const guide = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, {
      name: `TEST Sim ${randomUUID().slice(0, 8)}`, simulated: true, rows: [{ make: "TEST", model: "EX-1", year: 2025, tradeCents: 100, retailCents: 200 }],
    })
    const row = await database().assetValuation.create({ data: guideValuationData(fx.tenantId, fx.assets[0], guide.id, guide.rowIds[0], 100, fx.officer) as never })
    const stored = await database().assetValuation.findUniqueOrThrow({ where: { id: row.id } })
    expect(stored.guideSnapshot).toMatchObject({ simulated: true })
  })

  it("keeps a synthetic guide simulated, and the move times in order (CHECKs)", async () => {
    const on = (constraint: string) => ({ table: "ValuationGuide", constraint })
    await refuses(on("ValuationGuide_synthetic_simulated"), /ValuationGuide_synthetic_simulated/, (tx) => rawGuide(tx, { provider: "synthetic" }))
    // Triggers off: the guard writes the move times itself, so only a write around it can try another.
    await refuses(on("ValuationGuide_times"), /ValuationGuide_times/, async (tx) => {
      const { id } = await draft(tx)
      await triggersOff(tx)
      await tx.valuationGuide.update({ where: { id }, data: { status: "PUBLISHED", publishedById: fx.adminB, publishedAt: new Date("2001-01-01T00:00:00Z") } })
    })
  })

  it("dates every move itself: a caller's publish, discard or supersede time is replaced by the clock", async () => {
    const stamp = new Date("2001-01-01T00:00:00Z")
    // Admitted with the database's time; with that one assignment out, the caller's time stays and the times CHECK refuses it.
    const dated = async (tx: Tx, id: string, column: "publishedAt" | "discardedAt" | "supersededAt") => {
      const row = await tx.valuationGuide.findUniqueOrThrow({ where: { id } })
      if (row[column]?.getTime() === stamp.getTime()) throw new Error(`${column} kept the caller's time`)
    }
    const moves: [string, (tx: Tx) => Promise<unknown>][] = [
      [`NEW."publishedAt" := clock_timestamp();`, async (tx) => {
        const { id } = await draft(tx)
        await tx.valuationGuide.update({ where: { id }, data: { status: "PUBLISHED", publishedById: fx.adminB, publishedAt: stamp } })
        await dated(tx, id, "publishedAt")
      }],
      [`NEW."discardedAt" := clock_timestamp();`, async (tx) => {
        const { id } = await draft(tx)
        await tx.valuationGuide.update({ where: { id }, data: { status: "DISCARDED", discardedById: fx.adminA, discardedAt: stamp } })
        await dated(tx, id, "discardedAt")
      }],
      [`NEW."supersededAt" := clock_timestamp();`, async (tx) => {
        const name = `TEST Stamp ${randomUUID().slice(0, 8)}`
        const old = await publishedGuide(tx, fx.tenantId, fx.adminA, fx.adminB, { name, effectiveOn: day(-5) })
        const next = await draft(tx, { name, effectiveOn: day(-1) })
        await tx.valuationGuide.update({ where: { id: old.id }, data: { status: "SUPERSEDED", supersededById: next.id, supersededAt: stamp } })
        await publishGuideRow(tx, next.id, fx.adminB)
        await dated(tx, old.id, "supersededAt")
      }],
    ]
    for (const [assignment, move] of moves) {
      await admits(move)
      expect(await attempt(database(), move, clauseOff(G, assignment))).toMatch(/ValuationGuide_times/)
    }
  })

  it("supersedes a guide only by a draft put live in the same transaction: no cycle, no guide left without a current one", async () => {
    const successor = raiseOff(G, "A guide is superseded by another guide of the same name dated on or after it, a draft put live in the same transaction")
    await refuses(successor, /a draft put live in the same transaction/, async (tx) => {
      // A and B of one name and date: B replaces A, then B is taken down naming A.
      const name = `TEST Cycle ${randomUUID().slice(0, 8)}`
      const a = await publishedGuide(tx, fx.tenantId, fx.adminA, fx.adminB, { name, effectiveOn: day(-5) })
      const b = await draft(tx, { name, effectiveOn: day(-5) })
      await tx.valuationGuide.update({ where: { id: a.id }, data: { status: "SUPERSEDED", supersededById: b.id, supersededAt: new Date() } })
      await publishGuideRow(tx, b.id, fx.adminB)
      await tx.valuationGuide.update({ where: { id: b.id }, data: { status: "SUPERSEDED", supersededById: a.id, supersededAt: new Date() } })
    }, [{ table: "ValuationGuide", trigger: "ValuationGuide_successor_published" }])
  })

  it("refuses TRUNCATE on both guide tables (the FKs into them taken out, so only the guard is left)", async () => {
    const fks = [
      { table: "AssetValuation", constraint: "AssetValuation_tenantId_guideId_guideRowId_fkey" },
      { table: "AssetValuation", constraint: "AssetValuation_tenantId_guideId_fkey" },
      { table: "ValuationGuideRow", constraint: "ValuationGuideRow_tenantId_guideId_fkey" },
    ]
    const dropFks = async (tx: Tx) => {
      for (const fk of fks) await tx.$executeRawUnsafe(`ALTER TABLE "${fk.table}" DROP CONSTRAINT "${fk.constraint}"`)
    }
    await refuses({ table: "ValuationGuideRow", trigger: "ValuationGuideRow_no_truncate" }, /never changed or deleted/, async (tx) => {
      await dropFks(tx)
      await tx.$executeRawUnsafe(`TRUNCATE "ValuationGuideRow"`)
    })
    await refuses({ table: "ValuationGuide", trigger: "ValuationGuide_no_truncate" }, /never deleted/, async (tx) => {
      await dropFks(tx)
      await tx.$executeRawUnsafe(`TRUNCATE "ValuationGuide"`)
    })
  })
})
