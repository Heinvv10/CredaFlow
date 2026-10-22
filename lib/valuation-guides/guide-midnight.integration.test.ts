/**
 * The midnight race (review, PR #229): the app reads "today" (SAST) before its
 * transaction, the database's guards read it again inside. When the two fall
 * on either side of midnight the database refuses, and the route answers 409,
 * never a 500. The app's clock is shifted by a day here to stand for that.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-midnight.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const { session, clock } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
  clock: { shiftDays: 0 },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
vi.mock("@/lib/date/sast", async (original) => {
  const real = await original<typeof import("@/lib/date/sast")>()
  return { ...real, sastCalendarDate: (at: Date) => real.sastCalendarDate(new Date(at.getTime() + clock.shiftDays * 86_400_000)) }
})

import { POST as publishRoute } from "@/app/api/asset-finance/valuation-guides/[id]/publish/route"
import { POST as recordRoute } from "@/app/api/asset-finance/assets/[id]/guide-valuations/route"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { cleanupGuides, day, draftGuide, publishedGuide } from "./guide.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_VALUATION_IT=1 is required")
  return db
}
let fx: DealFixture

const as = (id: string, role: string) => {
  session.current = { user: { id, email: `${id}@guide-midnight.test`, role, tenantId: fx.tenantId } }
}
const request = (path: string, body: unknown) => new NextRequest(`http://${fx.host}${path}`, {
  method: "POST", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify(body),
})

suite.sequential("guide routes across SAST midnight (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createDealFixture(database(), t, { templates: false })
  }, 300_000)

  afterEach(() => {
    clock.shiftDays = 0
  })

  afterAll(async () => {
    session.current = null
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("records nothing, with 409, when the day turns between reading the guide and writing the valuation", async () => {
    const guide = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { effectiveOn: day(-5) })
    clock.shiftDays = -1 // the app still reads yesterday; the database is on today
    as(fx.officer, "CREDIT_OFFICER")
    const res = await recordRoute(request(`/api/asset-finance/assets/${fx.assets[0]}/guide-valuations`, { guideRowId: guide.rowIds[0] }),
      { params: Promise.resolve({ id: fx.assets[0] }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/day changed/)
    expect(await database().assetValuation.count({ where: { tenantId: fx.tenantId, guideId: guide.id } })).toBe(0)
  })

  it("refuses the publish with 409 when the app's day is already the guide's effective date and the database's is not", async () => {
    const tomorrow = day(1)
    const { id } = await draftGuide(database(), fx.tenantId, fx.adminA, { name: "TEST Midnight Guide", effectiveOn: tomorrow })
    clock.shiftDays = 1 // the app reads tomorrow; the database is still on today
    as(fx.adminB, "LOAN_ADMIN")
    const res = await publishRoute(request(`/api/asset-finance/valuation-guides/${id}/publish`, {}), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/takes effect on/)
    expect(await database().valuationGuide.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DRAFT" })
  })
})
