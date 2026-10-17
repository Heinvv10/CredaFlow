/**
 * Real-Postgres proof of the product kind (Fair Score audit E4): an
 * asset-finance deal takes only an ASSET_FINANCE product (the create route
 * refuses a consumer product, 422), and the consumer product filter keeps
 * asset-finance products out of every consumer list on the real enum. Only the
 * session is stubbed.
 *
 *   RUN_ASSET_FINANCE_DEAL_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/product-kind.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { CONSUMER_PRODUCT_WHERE } from "@/lib/product-config/product-kind"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, dealRoutes, type DealFixture } from "./deal.integration-fixture"
import { ASSET_FINANCE_PRODUCT_WHERE } from "./deal-products"
import { addMonthsClamped } from "./dates"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: Record<string, unknown> } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEAL_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealFixture
let consumerProduct = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_DEAL_IT=1 is required")
  return db
}

const body = (productId: string) => ({
  assetId: fx.assets[0], contractType: "INSTALMENT_SALE", depositCents: 17_250_000, balloonCents: 0,
  firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 2), preset: { kind: "MONTHLY", periods: 60 },
  rateBasis: "PRIME", rateMargin: "0.0100", entityId: fx.evidenced, supplierId: fx.supplier, productId,
})

suite.sequential("asset-finance product kind (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t)
    consumerProduct = (await database().loanProduct.create({
      data: {
        tenantId: fx.tenantId, code: `PL-${t}`, name: "TEST personal loan", productType: "PERSONAL",
        minAmount: 100, maxAmount: 1_000_000_000, minTermDays: 30, maxTermDays: 3_660, interestRatePm: 0.01, interestModel: "REDUCING_BALANCE",
      },
    })).id
  })

  afterAll(async () => {
    if (!db) return
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("filters the lender's products by kind on the real enum", async () => {
    const consumer = await database().loanProduct.findMany({ where: { tenantId: fx.tenantId, active: true, ...CONSUMER_PRODUCT_WHERE }, select: { id: true } })
    expect(consumer.map((p) => p.id)).toEqual([consumerProduct])
    const assetFinance = await database().loanProduct.findMany({ where: { tenantId: fx.tenantId, ...ASSET_FINANCE_PRODUCT_WHERE }, select: { id: true } })
    expect(assetFinance.map((p) => p.id)).toEqual([fx.product])
  })

  it("refuses a deal on a consumer product (422) and creates nothing; accepts the asset-finance product", async () => {
    session.current = { user: { id: fx.officer, email: "officer@deal-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId } }
    const refused = await dealRoutes(fx.host).create(body(consumerProduct))
    expect(refused.status).toBe(422)
    expect(await refused.text()).toContain("not an active asset-finance product")
    expect(await database().assetFinanceDeal.count({ where: { tenantId: fx.tenantId } })).toBe(0)

    const created = await dealRoutes(fx.host).create(body(fx.product))
    expect(created.status, await created.clone().text()).toBe(201)
  })
})
