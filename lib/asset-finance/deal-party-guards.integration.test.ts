/**
 * Real-Postgres proof that what the credit decision cross-checked still holds
 * when the money moves (review of #151, Fair Score E4/E5):
 *   - a party cannot be stepped off an entity while its deal is under review,
 *     nor added or reactivated once the deal is approved
 *     (EntityRelationship_fixed_on_open_deal);
 *   - an asset-finance deal's application keeps an ASSET_FINANCE product, and
 *     a product a deal uses stays one (guardAssetDealProductKind,
 *     guardAssetDealApplicationProductKind, guardAssetFinanceProductKind);
 *   - an exception that arises after approval (a surety's loan falls into
 *     default) stops payout creation and booking until it is resolved.
 * Only the session is stubbed; routes, triggers and CHECKs are real.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/deal-party-guards.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { POST as addPersonRoute } from "@/app/api/asset-finance/entities/[id]/people/route"
import { DELETE as deactivatePersonRoute } from "@/app/api/asset-finance/entities/[id]/people/[relationshipId]/route"
import { cleanupDealFixture, dealFixtureTenantId, dealRoutes } from "./deal.integration-fixture"
import { bookingRoutes, type SessionUser } from "./payout-booking.integration-fixture"
import { addMonthsClamped } from "./dates"
import {
  approveLease, cleanupLeaseRows, confirmChecklist, createAndApprovePayout, createLeaseFixture, leaseBody, payoutAndBook, signLease,
  type LeaseFixture,
} from "./lease.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let suretyLoanId = ""
let formerDirector = ""
let dealId = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const sqlError = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return String(error)
  }
  return "no error"
}
const people = (entityId: string, body?: unknown, relationshipId?: string) => {
  const path = `/api/asset-finance/entities/${entityId}/people${relationshipId ? `/${relationshipId}` : ""}`
  const request = new NextRequest(`http://${fx.host}${path}`, {
    method: relationshipId ? "DELETE" : "POST",
    headers: { host: fx.host, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return relationshipId
    ? deactivatePersonRoute(request, { params: Promise.resolve({ id: entityId, relationshipId }) })
    : addPersonRoute(request, { params: Promise.resolve({ id: entityId }) })
}
const setSuretyLoan = (status: "ACTIVE" | "DEFAULTED") =>
  database().loan.update({ where: { id: suretyLoanId }, data: status === "DEFAULTED" ? { status, daysInArrears: 120, arrearsAmount: 5_000_000 } : { status, daysInArrears: 0, arrearsAmount: 0 } })

suite.sequential("the people and product a deal was approved on stay fixed (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    const firstDue = addMonthsClamped(sastCalendarDate(new Date()), 1)
    // The sole proprietor's own lease, booked and current; they stand surety for the company.
    const own = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee, firstDueDate: firstDue,
    }))
    await signLease(fx, database(), setSession, own, firstDue)
    suretyLoanId = await payoutAndBook(fx, database(), staff, own)
    await database().entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId: fx.lessee, role: "SURETY" } })
    formerDirector = (await database().client.create({ data: {
      tenantId: fx.tenantId, firstName: "TEST", lastName: "Former", email: `former-${t}@client.invalid`, phone: `0003${t.slice(0, 6)}`,
      idNumber: `96${t.replace(/\D/g, "0").slice(0, 11)}`,
    } })).id
    await database().entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId: formerDirector, role: "DIRECTOR", active: false } })
  }, 360_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("under review: a director cannot be stepped off the entity (DB and route, 409)", async () => {
    staff(fx.officer, "CREDIT_OFFICER")
    const created = await dealRoutes(fx.host).create({
      assetId: fx.assets[3], contractType: "INSTALMENT_SALE", depositCents: 17_250_000, balloonCents: 0,
      firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 2), preset: { kind: "MONTHLY", periods: 60 },
      rateBasis: "PRIME", rateMargin: "0.0100", entityId: fx.unevidenced, supplierId: fx.supplier, productId: fx.product,
    })
    expect(created.status, await created.clone().text()).toBe(201)
    expect((await dealRoutes(fx.host).submit(((await created.json()) as { id: string }).id)).status).toBe(200)
    const director = await database().entityRelationship.findFirstOrThrow({ where: { entityId: fx.unevidenced, clientId: fx.director, role: "DIRECTOR" } })
    expect(await sqlError(() => database().entityRelationship.update({ where: { id: director.id }, data: { active: false } })))
      .toContain("The entity has a deal under review or approved")
    staff(fx.adminA, "LOAN_ADMIN")
    const refused = await people(fx.unevidenced, undefined, director.id)
    expect(refused.status).toBe(409)
    expect((await database().entityRelationship.findUniqueOrThrow({ where: { id: director.id } })).active).toBe(true)
  }, 60_000)

  it("approved: no party is added or reactivated (DB and route, 409)", async () => {
    dealId = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    expect(await sqlError(() => database().entityRelationship.updateMany({
      where: { entityId: fx.evidenced, clientId: formerDirector, role: "DIRECTOR" }, data: { active: true },
    }))).toContain("no director, trustee, surety or other party is added or reactivated")
    expect(await sqlError(() => database().entityRelationship.create({
      data: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId: formerDirector, role: "SURETY" },
    }))).toContain("no director, trustee, surety or other party is added or reactivated")
    staff(fx.officer, "CREDIT_OFFICER")
    const added = await people(fx.evidenced, { clientId: formerDirector, roles: ["SURETY"] })
    expect(added.status, await added.clone().text()).toBe(409)
  }, 120_000)

  it("the deal's application keeps an asset-finance product, and that product stays one", async () => {
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, select: { applicationId: true } })
    const consumer = await database().loanProduct.create({ data: {
      tenantId: fx.tenantId, code: `PL-${t}`, name: "TEST personal loan", productType: "PERSONAL",
      minAmount: 100, maxAmount: 1_000_000_000, minTermDays: 30, maxTermDays: 3_660, interestRatePm: 0.01, interestModel: "REDUCING_BALANCE",
    } })
    expect(await sqlError(() => database().loanApplication.update({ where: { id: deal.applicationId }, data: { productId: consumer.id } })))
      .toContain("must carry an asset-finance product")
    expect(await sqlError(() => database().loanProduct.update({ where: { id: fx.product }, data: { productType: "PERSONAL" } })))
      .toContain("it stays an asset-finance product")
  })

  it("an exception that arises after approval stops the payout and the booking until it is resolved", async () => {
    const firstDueDeal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, select: { approvalExceptionKeys: true } })
    expect(firstDueDeal.approvalExceptionKeys).toEqual([])
    await signLease(fx, database(), setSession, dealId)
    await confirmChecklist(fx, database(), staff, dealId)

    await setSuretyLoan("DEFAULTED")
    staff(fx.adminA, "LOAN_ADMIN")
    const payoutRefused = await bookingRoutes(fx.host).createPayout(dealId)
    expect(payoutRefused.status).toBe(409)
    expect(((await payoutRefused.json()) as { error: string }).error).toMatch(/New since the deal was approved.*TEST Soleprop \(Surety\)/)
    expect(await database().payout.count({ where: { dealId } })).toBe(0)

    await setSuretyLoan("ACTIVE")
    await createAndApprovePayout(fx, database(), staff, dealId)
    await setSuretyLoan("DEFAULTED")
    staff(fx.adminA, "LOAN_ADMIN")
    const bookRefused = await bookingRoutes(fx.host).book(dealId)
    expect(bookRefused.status).toBe(409)
    expect(((await bookRefused.json()) as { error: string }).error).toMatch(/New since the deal was approved/)
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })).status).toBe("CONTRACTED")

    await setSuretyLoan("ACTIVE")
    expect((await bookingRoutes(fx.host).book(dealId)).status).toBe(201)
  }, 180_000)
})
