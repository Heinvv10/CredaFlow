/**
 * Slice 5 part C valuation-guide rules (migration 20261021090100), each proved
 * as in the slice 4 suites: the attack is refused, and goes through with that
 * one statement, clause, CHECK, index or trigger taken out, inside a
 * rolled-back transaction. A guide is loaded as a DRAFT, published by a second
 * user on or after its effective date with every row it was loaded with,
 * never changed once published, one current per name, superseded only by a
 * newer guide of that name put live in the same transaction, never deleted;
 * rows are written only into a DRAFT and never changed.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-rules.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { dbDate } from "@/lib/asset-finance/dates"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { clauseOff, raiseOff, rules, type Tx } from "@/lib/asset-finance/recovery-rules.integration-fixture"
import { cleanupGuides, day, draftGuide, freshSha, publishedGuide, publishGuideRow, supersedeGuideRow } from "./guide.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
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
const R = "guardValuationGuideRow"
const MOVES = /moves only from DRAFT to PUBLISHED or DISCARDED, and from PUBLISHED to SUPERSEDED/
const FIXED = "A valuation guide changes only its status and who moved it, when: its name, date, source, file and rows never change"
const ROW_FIXED = "A guide row is never changed or deleted: load a new guide"
/** Lets an UPDATE or DELETE through once its refusal is gone. */
const PASS = "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;"
let fx: DealFixture
/** current: the PUBLISHED "TEST Plant Guide"; draft: a DRAFT of another name. */
const guides = { current: "", currentRow: "", currentSha: "", draft: "" }

const draft = (tx: Tx, o: Parameters<typeof draftGuide>[3] = {}) => draftGuide(tx, fx.tenantId, fx.adminA, { name: `TEST Draft ${randomUUID().slice(0, 8)}`, ...o })
const discard = (tx: Tx, id: string) => tx.valuationGuide.update({ where: { id }, data: { status: "DISCARDED", discardedById: fx.adminA, discardedAt: new Date() } })

suite("valuation guide database rules", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t, { templates: false })
    guides.currentSha = freshSha()
    const current = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { effectiveOn: day(-10), sha: guides.currentSha })
    guides.current = current.id
    guides.currentRow = current.rowIds[0]
    guides.draft = (await draftGuide(database(), fx.tenantId, fx.adminA, { name: "TEST Other Guide" })).id
  }, 300_000)

  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("loads a guide as a DRAFT only", async () => {
    await refuses(raiseOff(G, "A valuation guide is loaded as a DRAFT"), /loaded as a DRAFT/, (tx) => tx.valuationGuide.create({
      data: {
        tenantId: fx.tenantId, name: "TEST Born Live", effectiveOn: dbDate(day(-1)), provider: "csv", fileSha256: freshSha(), rowCount: 1,
        uploadedById: fx.adminA, status: "PUBLISHED", publishedById: fx.adminB, publishedAt: new Date(),
      },
    }), [// The guard dates the upload by the clock, after this publish time: the times CHECK out too.
      { table: "ValuationGuide", constraint: "ValuationGuide_times" }])
  })

  it("is published by someone other than its uploader (four-eyes)", async () => {
    await admits(async (tx) => publishGuideRow(tx, (await draft(tx)).id, fx.adminB))
    await refuses({ table: "ValuationGuide", constraint: "ValuationGuide_four_eyes" }, /ValuationGuide_four_eyes/,
      async (tx) => publishGuideRow(tx, (await draft(tx)).id, fx.adminA))
  })

  it("is published on or after its effective date, with every row it was loaded with", async () => {
    await refuses(raiseOff(G, "A guide is published on or after its effective date"), /on or after its effective date/,
      async (tx) => publishGuideRow(tx, (await draft(tx, { effectiveOn: day(1) })).id, fx.adminB))
    await refuses(raiseOff(G, "A guide is published with every row it was loaded with"), /every row it was loaded with/,
      async (tx) => publishGuideRow(tx, (await draft(tx, { rowCount: 4 })).id, fx.adminB))
  })

  it("never changes once published: no rename, re-date, re-count or re-publish", async () => {
    const moves = clauseOff(G, "IF allowed IS NULL THEN", "IF FALSE THEN")
    for (const data of [{ name: "TEST Renamed" }, { effectiveOn: dbDate(day(-11)) }, { rowCount: 9 }, { fileSha256: freshSha() }, { publishedAt: new Date(0) }]) {
      // (A publish time before the upload is also refused by ValuationGuide_times: out too, so the move rule shows alone.)
      await refuses(moves, MOVES, (tx) => tx.valuationGuide.update({ where: { id: guides.current }, data }), [{ table: "ValuationGuide", constraint: "ValuationGuide_times" }])
    }
    // Nor may a move carry another change with it.
    await refuses(raiseOff(G, FIXED), /changes only its status/,
      async (tx) => tx.valuationGuide.update({ where: { id: (await draft(tx)).id }, data: { status: "PUBLISHED", publishedById: fx.adminB, publishedAt: new Date(), name: "TEST Swapped" } }))
    await refuses(raiseOff(G, FIXED), /changes only its status/, async (tx) => {
      const next = await draftGuide(tx, fx.tenantId, fx.adminA, { effectiveOn: day(-1) })
      await tx.valuationGuide.update({ where: { id: guides.current }, data: { status: "SUPERSEDED", supersededById: next.id, supersededAt: new Date(), rowCount: 9 } })
      await publishGuideRow(tx, next.id, fx.adminB)
    })
  })

  it("moves only DRAFT → PUBLISHED or DISCARDED and PUBLISHED → SUPERSEDED", async () => {
    const moves = clauseOff(G, "IF allowed IS NULL THEN", "IF FALSE THEN")
    await admits(async (tx) => discard(tx, (await draft(tx)).id))
    await refuses(moves, MOVES, async (tx) => {
      const { id } = await draft(tx)
      await discard(tx, id)
      await tx.valuationGuide.update({ where: { id }, data: { status: "PUBLISHED", publishedById: fx.adminB, publishedAt: new Date(), discardedById: null, discardedAt: null } })
    })
    await refuses(moves, MOVES, (tx) => tx.valuationGuide.update({ where: { id: guides.current }, data: { status: "DRAFT", publishedById: null, publishedAt: null } }))
  })

  it("is never deleted", async () => {
    await refuses(raiseOff(G, "A valuation guide is never deleted: discard a draft", PASS), /never deleted/,
      async (tx) => tx.valuationGuide.delete({ where: { id: (await draftGuide(tx, fx.tenantId, fx.adminA, { name: "TEST Empty", rows: [], rowCount: 1 })).id } }))
  })

  it("keeps one current guide per name, superseded only by a newer one put live in the same transaction", async () => {
    // The house path: supersede the current one, publish its successor.
    await admits(async (tx) => {
      const next = await draftGuide(tx, fx.tenantId, fx.adminA, { effectiveOn: day(-1) })
      await supersedeGuideRow(tx, guides.current, next.id)
      await publishGuideRow(tx, next.id, fx.adminB)
    })
    await refuses({ index: "ValuationGuide_one_current_per_name" }, /Key \("tenantId", lower\(name\)\)=.* already exists/, async (tx) => {
      const { id } = await draftGuide(tx, fx.tenantId, fx.adminA, { name: "test plant guide", effectiveOn: day(-1) })
      await tx.$executeRawUnsafe(`UPDATE "ValuationGuide" SET "status" = 'PUBLISHED', "publishedById" = $1, "publishedAt" = now() WHERE "id" = $2`, fx.adminB, id)
    })
    await refuses({ table: "ValuationGuide", trigger: "ValuationGuide_successor_published" }, /successor is published by the end of its transaction/, async (tx) => {
      const next = await draftGuide(tx, fx.tenantId, fx.adminA, { effectiveOn: day(-1) })
      await supersedeGuideRow(tx, guides.current, next.id) // the successor is never put live
    })
    const successor = raiseOff(G, "A guide is superseded by another guide of the same name dated on or after it, a draft put live in the same transaction")
    for (const o of [{ effectiveOn: day(-20) }, { name: "TEST Another Name", effectiveOn: day(-1) }]) {
      await refuses(successor, /same name dated on or after it/, async (tx) => {
        const next = await draftGuide(tx, fx.tenantId, fx.adminA, o)
        await supersedeGuideRow(tx, guides.current, next.id)
        await publishGuideRow(tx, next.id, fx.adminB)
      })
    }
  })

  it("loads the same file once while a draft or a published guide carries it", async () => {
    await refuses({ index: "ValuationGuide_live_file" }, /Key \("tenantId", "fileSha256"\)=.* already exists/, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "ValuationGuide" ("id", "tenantId", "name", "effectiveOn", "provider", "fileSha256", "rowCount", "uploadedById")
       VALUES ($1, $2, 'TEST Again', CURRENT_DATE, 'csv', $3, 1, $4)`, `vg_${randomUUID()}`, fx.tenantId, guides.currentSha, fx.adminA))
    // A discarded draft's file may be loaded again.
    await admits(async (tx) => {
      const sha = freshSha()
      await discard(tx, (await draft(tx, { sha })).id)
      await draft(tx, { sha })
    })
  })

  it("writes rows only into a DRAFT and never changes or deletes them", async () => {
    await refuses(raiseOff(R, "Rows are added to a DRAFT guide only"), /DRAFT guide only/, (tx) => tx.valuationGuideRow.create({
      data: { tenantId: fx.tenantId, guideId: guides.current, lineNumber: 99, make: "TEST", model: "EX-9", year: 2025, tradeCents: 1, retailCents: 1 },
    }))
    await refuses(raiseOff(R, ROW_FIXED, PASS), /never changed or deleted/,
      (tx) => tx.valuationGuideRow.update({ where: { id: guides.currentRow }, data: { tradeCents: 1 } }))
    await refuses(raiseOff(R, ROW_FIXED, PASS), /never changed or deleted/,
      async (tx) => tx.valuationGuideRow.delete({ where: { id: (await draft(tx)).rowIds[0] } }))
  })

  it("holds each row to its shape and its key", async () => {
    let nextLine = 100
    const row = (tx: Tx, data: Record<string, unknown>) => tx.$executeRawUnsafe(
      `INSERT INTO "ValuationGuideRow" ("id", "tenantId", "guideId", "lineNumber", "make", "model", "year", "variant", "tradeCents", "retailCents")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      `vgr_${randomUUID()}`, fx.tenantId, guides.draft, data.lineNumber ?? nextLine++, data.make ?? "TEST", data.model ?? "EX-7", data.year ?? 2025,
      data.variant ?? "", data.trade ?? 100, data.retail ?? 200,
    )
    await admits((tx) => row(tx, {}))
    await refuses({ table: "ValuationGuideRow", constraint: "ValuationGuideRow_amounts" }, /ValuationGuideRow_amounts/, (tx) => row(tx, { trade: 300 }))
    await refuses({ table: "ValuationGuideRow", constraint: "ValuationGuideRow_amounts" }, /ValuationGuideRow_amounts/, (tx) => row(tx, { trade: 0 }))
    await refuses({ table: "ValuationGuideRow", constraint: "ValuationGuideRow_text" }, /ValuationGuideRow_text/, (tx) => row(tx, { make: " " }))
    await refuses({ table: "ValuationGuideRow", constraint: "ValuationGuideRow_text" }, /ValuationGuideRow_text/, (tx) => row(tx, { variant: " Long " }))
    await refuses({ table: "ValuationGuideRow", constraint: "ValuationGuideRow_year" }, /ValuationGuideRow_year/, (tx) => row(tx, { year: 1949 }))
    await refuses({ table: "ValuationGuideRow", constraint: "ValuationGuideRow_line" }, /ValuationGuideRow_line/, (tx) => row(tx, { lineNumber: 1 }))
    await refuses({ index: "ValuationGuideRow_key" }, /Key \("tenantId", "guideId", lower\(make\), lower\(model\), year, lower\(variant\)\)=.* already exists/, async (tx) => {
      await row(tx, {})
      await row(tx, { make: "test", model: "ex-7" })
    })
  })
})
