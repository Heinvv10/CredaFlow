/**
 * Slice 5 part C through the real routes (only the session is stubbed): a
 * LOAN_ADMIN uploads a guide, refused with per-line reasons and nothing stored
 * when the file is malformed; a second admin publishes it (the uploader is
 * refused, audited), superseding the guide of that name; staff record a GUIDE
 * valuation of an asset from it. Another lender's guide or row is 404.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-routes.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { GET as listGuides, POST as uploadGuide } from "@/app/api/asset-finance/valuation-guides/route"
import { POST as publishRoute } from "@/app/api/asset-finance/valuation-guides/[id]/publish/route"
import { POST as discardRoute } from "@/app/api/asset-finance/valuation-guides/[id]/discard/route"
import { GET as candidatesRoute, POST as recordRoute } from "@/app/api/asset-finance/assets/[id]/guide-valuations/route"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { cleanupGuides } from "./guide.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const t2 = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_VALUATION_IT=1 is required")
  return db
}
let fx: DealFixture
let other: DealFixture
let readonly = ""

const HEADER = "make,model,year,variant,trade_cents,retail_cents"
const VALID = [HEADER, "TEST,EX-1,2025,,120000000,140000000", "TEST,EX-1,2025,Long reach,125000000,146000000", "TEST,EX-2,2025,,110000000,130000000"].join("\r\n")
const MALFORMED = [HEADER, "TEST,EX-1,2025,,120000000.50,140000000", "TEST,EX-1,2025,,1,2", "TEST,EX-1,2025,,1,2", "TEST,,2025,,5,4"].join("\n")

const as = (f: DealFixture, id: string, role: string) => {
  session.current = { user: { id, email: `${id}@guide-it.test`, role, tenantId: f.tenantId } }
}
const request = (f: DealFixture, path: string, init: { method?: string; body?: BodyInit; json?: unknown } = {}) => new NextRequest(`http://${f.host}${path}`, {
  method: init.method ?? (init.body !== undefined || init.json !== undefined ? "POST" : "GET"),
  headers: { host: f.host, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
  ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body !== undefined ? { body: init.body } : {}),
})
function upload(f: DealFixture, fields: { name?: string; effectiveOn?: string; provider?: string; csv?: string }) {
  const form = new FormData()
  form.set("name", fields.name ?? "TEST Plant Guide")
  form.set("effectiveOn", fields.effectiveOn ?? "2026-01-01")
  if (fields.provider) form.set("provider", fields.provider)
  if (fields.csv !== undefined) form.set("file", new File([fields.csv], "guide.csv", { type: "text/csv" }))
  return uploadGuide(request(f, "/api/asset-finance/valuation-guides", { body: form }))
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const publish = (f: DealFixture, id: string) => publishRoute(request(f, `/api/asset-finance/valuation-guides/${id}/publish`, { json: {} }), params(id))
const discard = (f: DealFixture, id: string) => discardRoute(request(f, `/api/asset-finance/valuation-guides/${id}/discard`, { json: {} }), params(id))
const candidates = (f: DealFixture, assetId: string) => candidatesRoute(request(f, `/api/asset-finance/assets/${assetId}/guide-valuations`), params(assetId))
const record = (f: DealFixture, assetId: string, guideRowId: string) =>
  recordRoute(request(f, `/api/asset-finance/assets/${assetId}/guide-valuations`, { json: { guideRowId } }), params(assetId))
const audits = (f: DealFixture, action: string) => database().auditLog.findMany({ where: { tenantId: f.tenantId, action } })

suite.sequential("valuation guide routes (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createDealFixture(database(), t, { templates: false })
    other = await createDealFixture(database(), t2, { templates: false })
    readonly = (await database().user.create({ data: { tenantId: fx.tenantId, email: `readonly-${t}@staff.invalid`, password: "x", role: "READONLY" } })).id
  }, 300_000)

  afterAll(async () => {
    session.current = null
    if (!db) return
    for (const [f, token] of [[fx, t], [other, t2]] as const) {
      const tenantId = f?.tenantId ?? dealFixtureTenantId(token)
      await cleanupGuides(db, tenantId).catch(() => undefined)
      await cleanupDealFixture(db, f ?? { tenantId })
    }
    await db.$disconnect()
  })

  it("lets only a guide manager upload", async () => {
    as(fx, fx.officer, "CREDIT_OFFICER")
    expect((await upload(fx, { csv: VALID })).status).toBe(403)
  })

  it("refuses a malformed file with a reason per line, stores nothing, and audits the refusal without the cell values", async () => {
    as(fx, fx.adminA, "LOAN_ADMIN")
    const res = await upload(fx, { csv: MALFORMED })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.total).toBe(3)
    expect(body.problems.map((p: { line: number }) => p.line)).toEqual([2, 4, 5])
    expect(body.problems[0].reason).toMatch(/whole number of cents/)
    expect(body.problems[1].reason).toMatch(/line 3/)
    expect(body.problems[2].reason).toMatch(/model is required.*trade value is above the retail value/)
    expect(await database().valuationGuide.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    const [refusal] = await audits(fx, "VALUATION_GUIDE_UPLOAD_REFUSED")
    expect(refusal.newValue).toMatchObject({ problems: 3 })
    expect(JSON.stringify(refusal)).not.toContain("120000000.50")
  })

  it("stores a clean file as a DRAFT; the same file is refused while that draft is live", async () => {
    as(fx, fx.adminA, "LOAN_ADMIN")
    const res = await upload(fx, { csv: VALID })
    expect(res.status).toBe(201)
    const draft = await res.json()
    expect(draft).toMatchObject({ status: "DRAFT", rowCount: 3, provider: "csv", simulated: false })
    expect(await database().valuationGuideRow.count({ where: { guideId: draft.id } })).toBe(3)
    expect(await audits(fx, "VALUATION_GUIDE_UPLOADED")).toHaveLength(1)
    expect((await upload(fx, { csv: VALID, name: "TEST Copy" })).status).toBe(409)
  })

  it("refuses the uploader's own publish (audited), and publishes on a second admin's", async () => {
    const id = (await database().valuationGuide.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "DRAFT" } })).id
    as(fx, fx.adminA, "LOAN_ADMIN")
    expect((await publish(fx, id)).status).toBe(403)
    expect(await audits(fx, "VALUATION_GUIDE_PUBLISH_REFUSED")).toHaveLength(1)
    as(fx, fx.officer, "CREDIT_OFFICER")
    expect((await publish(fx, id)).status).toBe(403)
    as(fx, fx.adminB, "LOAN_ADMIN")
    const res = await publish(fx, id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id, status: "PUBLISHED", superseded: null })
    expect((await publish(fx, id)).status).toBe(409)
    as(fx, fx.adminA, "LOAN_ADMIN")
    expect((await discard(fx, id)).status).toBe(409)
  })

  it("supersedes the guide of the same name when a newer one is published", async () => {
    const first = (await database().valuationGuide.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "PUBLISHED" } })).id
    as(fx, fx.adminB, "LOAN_ADMIN")
    const res = await upload(fx, { csv: `${VALID}\r\nTEST,EX-3,2025,,1000,2000`, effectiveOn: "2026-02-01" })
    expect(res.status).toBe(201)
    const second = (await res.json()).id
    as(fx, fx.adminA, "LOAN_ADMIN")
    expect(await (await publish(fx, second)).json()).toMatchObject({ status: "PUBLISHED", superseded: first })
    expect(await database().valuationGuide.findUniqueOrThrow({ where: { id: first } })).toMatchObject({ status: "SUPERSEDED", supersededById: second })
  })

  it("lets a draft be discarded, by its uploader too", async () => {
    as(fx, fx.adminA, "LOAN_ADMIN")
    const id = (await (await upload(fx, { csv: `${HEADER}\nTEST,EX-4,2025,,1,1`, name: "TEST Scratch" })).json()).id
    const res = await discard(fx, id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id, status: "DISCARDED" })
    expect(await audits(fx, "VALUATION_GUIDE_DISCARDED")).toHaveLength(1)
  })

  it("offers the current guide's rows for an asset and records the chosen one at its trade value", async () => {
    as(fx, readonly, "READONLY")
    const res = await candidates(fx, fx.assets[0])
    expect(res.status).toBe(200)
    const { candidates: rows } = await res.json()
    expect(rows.map((r: { variant: string }) => r.variant).sort()).toEqual(["", "Long reach"])
    const longReach = rows.find((r: { variant: string }) => r.variant === "Long reach")
    expect(longReach).toMatchObject({ guideName: "TEST Plant Guide", effectiveOn: "2026-02-01", tradeCents: 125_000_000, retailCents: 146_000_000, simulated: false })
    expect((await record(fx, fx.assets[0], longReach.guideRowId)).status).toBe(403)
    as(fx, fx.officer, "CREDIT_OFFICER")
    const recorded = await record(fx, fx.assets[0], longReach.guideRowId)
    expect(recorded.status).toBe(201)
    expect(await recorded.json()).toMatchObject({ source: "GUIDE", amountCents: 125_000_000, guideRowId: longReach.guideRowId })
    expect(await audits(fx, "ASSET_GUIDE_VALUATION_RECORDED")).toHaveLength(1)
    // A row that is not a candidate for this asset (an EX-2 row on an EX-1) is not found.
    const ex2 = await database().valuationGuideRow.findFirstOrThrow({ where: { tenantId: fx.tenantId, model: "EX-2", guide: { status: "PUBLISHED" } } })
    expect((await record(fx, fx.assets[0], ex2.id)).status).toBe(404)
  })

  it("never reaches another lender's guide or row: 404", async () => {
    const guide = await database().valuationGuide.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "PUBLISHED" }, include: { rows: true } })
    const draft = (await database().valuationGuide.create({
      data: { tenantId: fx.tenantId, name: "TEST Foreign Draft", effectiveOn: new Date("2026-01-01"), provider: "csv", fileSha256: "a".repeat(64), rowCount: 1, uploadedById: fx.adminA },
    })).id
    as(other, other.adminB, "LOAN_ADMIN")
    expect((await publish(other, draft)).status).toBe(404)
    expect((await discard(other, draft)).status).toBe(404)
    as(other, other.officer, "CREDIT_OFFICER")
    expect((await record(other, other.assets[0], guide.rows[0].id)).status).toBe(404)
    expect((await candidates(other, fx.assets[0])).status).toBe(404)
    as(other, other.adminA, "LOAN_ADMIN")
    const list = await (await listGuides(request(other, "/api/asset-finance/valuation-guides"))).json()
    expect(list.guides).toEqual([])
  })

  it("loads the synthetic provider's guide outside a deployed build, labelled simulated", async () => {
    as(other, other.adminA, "LOAN_ADMIN")
    const res = await upload(other, { provider: "synthetic", name: "TEST Synthetic Guide" })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ status: "DRAFT", provider: "synthetic", simulated: true })
  })
})
