/**
 * Real-Postgres proof of the reference-rate four-eyes rule (DESIGN D4): a
 * value is recorded PENDING, a different user with decide_asset_finance
 * approves it, only an APPROVED value is a rate, and an approval that
 * reprices nothing because it is backdated raises a bell item for the loan
 * admins. Refusals (no authority, self-decision) are 403 and audited.
 *
 * Only the session is stubbed: the role guard, the tenant resolver (by host),
 * the feature flag, the routes, the audit writer and the database rules are real.
 *
 *   RUN_ASSET_FINANCE_RATES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/asset-finance/reference-rates/four-eyes.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { prisma } from "@/lib/prisma"
import { referenceRateOn } from "@/lib/asset-finance/rates-store"
import { sastCalendarDate } from "@/lib/date/sast"
import { GET, POST as record } from "./route"
import { POST as decide } from "./[id]/decide/route"

const RUN = process.env.RUN_ASSET_FINANCE_RATES_IT === "1"
const suite = RUN ? describe : describe.skip
const db = new PrismaClient()

const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_af_rates_${t}`
const host = `af-rates-${t}.rates-it.test`
const ids = { adminA: "", adminB: "", officer: "", backdated: "" }

const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@rates-it.test`, role, tenantId } }
}
const request = (path: string, body?: unknown) => new NextRequest(`http://${host}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { host, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const postRate = (body: unknown) => record(request("/api/asset-finance/reference-rates", body))
const postDecision = (id: string, decision: string) =>
  decide(request(`/api/asset-finance/reference-rates/${id}/decide`, { decision }), { params: Promise.resolve({ id }) })
const refusals = () => db.auditLog.findMany({ where: { tenantId, action: "REFERENCE_RATE_REFUSED" }, orderBy: { createdAt: "asc" } })
const shift = (days: number) => sastCalendarDate(new Date(Date.now() + days * 86_400_000))

suite.sequential("reference-rate four-eyes (real Postgres, real routes)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `af-rates-${t}`, name: "Rates IT", domain: host } })
    await db.tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
    const user = (label: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") =>
      db.user.create({ data: { tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role } })
    ids.adminA = (await user("admin-a", "LOAN_ADMIN")).id
    ids.adminB = (await user("admin-b", "LOAN_ADMIN")).id
    ids.officer = (await user("officer", "CREDIT_OFFICER")).id
  })

  afterAll(async () => {
    await db.notification.deleteMany({ where: { tenantId } })
    await db.auditLog.deleteMany({ where: { tenantId } })
    // An approved value is never deleted (guardReferenceRateLifecycle); only this
    // test's rows go, with triggers off for the transaction.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.referenceRate.deleteMany({ where: { tenantId } }),
    ])
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("refuses a CREDIT_OFFICER's recording with a 403 and an audit row", async () => {
    signIn(ids.officer, "CREDIT_OFFICER")
    expect((await postRate({ basis: "PRIME", effectiveDate: shift(-30), rate: "0.1175" })).status).toBe(403)
    expect(await db.referenceRate.count({ where: { tenantId } })).toBe(0)
    expect((await refusals()).map((r) => [r.userId, (r.newValue as { reason: string }).reason])).toEqual([[ids.officer, "insufficient_role"]])
  })

  it("records PENDING; the requester cannot approve it (403, audited); a PENDING value is not a rate", async () => {
    signIn(ids.adminA, "LOAN_ADMIN")
    const response = await postRate({ basis: "PRIME", effectiveDate: shift(-30), rate: "0.1175" })
    expect(response.status).toBe(201)
    const created = await response.json()
    expect(created).toMatchObject({ status: "PENDING", requestedById: ids.adminA, decidedById: null })
    ids.backdated = created.id
    expect(await referenceRateOn(prisma, tenantId, "PRIME", shift(0))).toBeNull()

    expect((await postDecision(ids.backdated, "APPROVE")).status).toBe(403)
    expect((await refusals()).at(-1)?.newValue).toMatchObject({ reason: "four_eyes_self_decision", httpStatus: 403 })
    expect((await db.referenceRate.findUniqueOrThrow({ where: { id: ids.backdated } })).status).toBe("PENDING")
  })

  it("a second admin approves it; the backdated approval reprices nothing, so every loan admin gets a bell item", async () => {
    signIn(ids.adminB, "LOAN_ADMIN")
    const response = await postDecision(ids.backdated, "APPROVE")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "APPROVED", decidedById: ids.adminB, reach: { wouldReprice: 0, backdated: true, superseded: false, alerted: true },
    })
    expect((await referenceRateOn(prisma, tenantId, "PRIME", shift(0)))?.rate.toString()).toBe("0.1175")
    const bell = await db.notification.findMany({ where: { tenantId, entityId: ids.backdated }, orderBy: { userId: "asc" } })
    expect(bell.map((n) => [n.userId, n.type])).toEqual([[ids.adminA, "REFERENCE_RATE_NO_EFFECT"], [ids.adminB, "REFERENCE_RATE_NO_EFFECT"]].sort())
    expect(await db.auditLog.count({ where: { tenantId, entityId: ids.backdated, action: "REFERENCE_RATE_DECIDED" } })).toBe(1)
    expect((await postDecision(ids.backdated, "REJECT")).status).toBe(409)
  })

  it("a future-dated approval raises no bell; a rejected value can be recorded again", async () => {
    signIn(ids.adminA, "LOAN_ADMIN")
    const future = await (await postRate({ basis: "PRIME", effectiveDate: shift(30), rate: "0.12" })).json()
    signIn(ids.adminB, "LOAN_ADMIN")
    expect(await (await postDecision(future.id, "APPROVE")).json()).toMatchObject({ reach: { alerted: false, backdated: false } })
    expect(await db.notification.count({ where: { tenantId, entityId: future.id } })).toBe(0)

    const rejected = await (await postRate({ basis: "REPO", effectiveDate: shift(-1), rate: "0.0825" })).json()
    signIn(ids.adminA, "LOAN_ADMIN")
    expect((await postDecision(rejected.id, "REJECT")).status).toBe(200)
    expect((await postRate({ basis: "REPO", effectiveDate: shift(-1), rate: "0.08" })).status).toBe(201)
    expect((await postRate({ basis: "REPO", effectiveDate: shift(-1), rate: "0.081" })).status).toBe(409)
  })

  it("GET lists the tenant's values with their status, paginated", async () => {
    const page = await (await GET(request("/api/asset-finance/reference-rates?limit=2"))).json()
    expect(page.rates).toHaveLength(2)
    expect(page.nextOffset).toBe(2)
    const rest = await (await GET(request("/api/asset-finance/reference-rates?offset=2"))).json()
    expect([...page.rates, ...rest.rates].map((r: { status: string }) => r.status).sort()).toEqual(["APPROVED", "APPROVED", "PENDING", "REJECTED"])
  })
})
