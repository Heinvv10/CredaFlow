/**
 * The publish route's refusals (review repros, PR #229): without them the
 * database trigger still refuses, but as an unhandled 500, and a simulated
 * guide would go live on a deployed build. And the upload's size cap, read
 * before the body is buffered.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-gaps-routes.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { POST as uploadGuide } from "@/app/api/asset-finance/valuation-guides/route"
import { POST as publishRoute } from "@/app/api/asset-finance/valuation-guides/[id]/publish/route"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { cleanupGuides, day } from "./guide.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_VALUATION_IT=1 is required")
  return db
}
let fx: DealFixture

const csv = (model: string) => ["make,model,year,variant,trade_cents,retail_cents", `TEST,${model},2025,,100,200`].join("\n")
const as = (id: string) => {
  session.current = { user: { id, email: `${id}@guide-gaps.test`, role: "LOAN_ADMIN", tenantId: fx.tenantId } }
}
const request = (path: string, body?: BodyInit) => new NextRequest(`http://${fx.host}${path}`, {
  method: "POST", headers: { host: fx.host, ...(body ? {} : { "content-type": "application/json" }) }, body: body ?? "{}",
})
async function upload(fields: { name: string; effectiveOn: string; provider?: string; model?: string }): Promise<string> {
  const form = new FormData()
  form.set("name", fields.name)
  form.set("effectiveOn", fields.effectiveOn)
  if (fields.provider) form.set("provider", fields.provider)
  else form.set("file", new File([csv(fields.model ?? `EX-${randomUUID().slice(0, 6)}`)], "guide.csv", { type: "text/csv" }))
  const res = await uploadGuide(request("/api/asset-finance/valuation-guides", form))
  expect(res.status).toBe(201)
  return (await res.json()).id
}
const publish = (id: string) => publishRoute(request(`/api/asset-finance/valuation-guides/${id}/publish`), { params: Promise.resolve({ id }) })

suite.sequential("publish route refusals (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createDealFixture(database(), t, { templates: false })
  }, 300_000)

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    session.current = null
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("refuses a guide before its effective date with 409, not a database error", async () => {
    as(fx.adminA)
    const id = await upload({ name: "TEST Future Guide", effectiveOn: day(5) })
    as(fx.adminB)
    const res = await publish(id)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/takes effect on/)
    expect(await database().valuationGuide.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DRAFT" })
  })

  it("refuses a guide dated before the current guide of its name with 409, and leaves the current one live", async () => {
    as(fx.adminA)
    const current = await upload({ name: "TEST Dated Guide", effectiveOn: day(-2) })
    as(fx.adminB)
    expect((await publish(current)).status).toBe(200)
    as(fx.adminA)
    const older = await upload({ name: "TEST Dated Guide", effectiveOn: day(-9) })
    as(fx.adminB)
    const res = await publish(older)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/effective .* after this one/)
    expect(await database().valuationGuide.findUniqueOrThrow({ where: { id: current } })).toMatchObject({ status: "PUBLISHED" })
  })

  it("refuses to take a simulated guide live on a deployed build", async () => {
    as(fx.adminA)
    const id = await upload({ name: "TEST Simulated Guide", effectiveOn: day(-1), provider: "synthetic" })
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    as(fx.adminB)
    const res = await publish(id)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/simulated guide cannot go live/)
    expect(await database().valuationGuide.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DRAFT" })
  })

  it("refuses a body over the cap with 422 before reading it as a form, and stores nothing", async () => {
    as(fx.adminA)
    const before = await database().valuationGuide.count({ where: { tenantId: fx.tenantId } })
    const form = new FormData()
    form.set("name", "TEST Huge Guide")
    form.set("effectiveOn", day(-1))
    // The file alone is under 5 MB; the body is not. Only the body cap can refuse this one.
    form.set("padding", "x".repeat(2 * 1024 * 1024))
    form.set("file", new File([new Uint8Array(4 * 1024 * 1024)], "guide.csv", { type: "text/csv" }))
    const res = await uploadGuide(request("/api/asset-finance/valuation-guides", form))
    expect(res.status).toBe(422)
    expect((await res.json()).problems).toEqual([{ line: 1, reason: "The upload is larger than 5 MB" }])
    expect(await database().valuationGuide.count({ where: { tenantId: fx.tenantId } })).toBe(before)
  })
})
