/**
 * Real-Postgres proof of the staff dealer administration (manage_dealers):
 * registering and editing a dealer (VAT vendor follows the VAT number; one
 * dealer per name and per supplier), its first dealer admin with a one-time
 * set-password link, deactivation ending every user's sessions, date-effective
 * commission rates for a dealer and the tenant default (never edited), and
 * dealer bank accounts captured by staff and decided by a second user with
 * the manual verification recorded; the settings switch refused 422 by the
 * demo-only CHECK on a lender that is not a demo. Every write audited.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/staff-admin.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { prisma } from "@/lib/prisma"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, type DealerFixture } from "./dealer.integration-fixture"
import { inTenant, staffOf } from "./dealer-origination.integration-fixture"
import { hashDealerToken } from "./password-links"
import { createDealer, updateDealer, type DealerFields } from "./staff-dealers"
import { setCommissionRate } from "./staff-rates"
import { decideDealerBankAccount, requestDealerBankAccount } from "./staff-bank-accounts"
import { createDealerUser, deactivateDealer } from "./users"
import { NextRequest } from "next/server"
import { PATCH as settingsPatch } from "@/app/api/settings/asset-finance/route"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: Record<string, unknown> } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let dealerId: string

const fields = (over: Partial<DealerFields> = {}): DealerFields => ({
  name: `TEST Yellow Iron ${t}`, kind: "BROKER", registrationNumber: null, vatNumber: null, supplierId: null,
  contactEmail: "desk@broker.invalid", contactPhone: null, ...over,
})
const audit = (entityId: string, action: string) =>
  sql(`SELECT "userId" FROM "AuditLog" WHERE "tenantId" = ${lit(fx.tenantId)} AND "entityId" = ${lit(entityId)} AND "action" = '${action}'`)
const account = { bankName: "TEST Bank", branchCode: "000001", accountNumber: "62000000001", accountHolder: "TEST Yellow Iron CC", accountType: null }
const decide = (accountId: string, decider: string, decision: "APPROVE" | "REJECT" = "APPROVE") =>
  inTenant(fx, () => prisma.$transaction((tx) => decideDealerBankAccount(tx, {
    tenantId: fx.tenantId, accountId, decision, note: "TEST bank-stamped letter checked", decider: { id: decider },
  })))

suite.sequential("staff dealer administration (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("registers a dealer, audited; refuses a duplicate name, another lender's supplier and a supplier already linked", async () => {
    const created = await inTenant(fx, () => createDealer(staffOf(fx, fx.adminA), fields({ supplierId: fx.supplier })))
    if (created.kind !== "created") throw new Error(JSON.stringify(created))
    dealerId = created.dealerId
    expect(sql(`SELECT "kind", "vatVendor", "active", "createdById", "supplierId" FROM "Dealer" WHERE "id" = ${lit(dealerId)}`))
      .toBe(`BROKER|f|t|${fx.adminA}|${fx.supplier}`)
    expect(audit(dealerId, "DEALER_CREATED")).toBe(fx.adminA)
    expect(await inTenant(fx, () => createDealer(staffOf(fx, fx.adminA), fields())))
      .toEqual({ kind: "refused", status: 409, error: "A dealer with this name is already registered" })
    expect(await inTenant(fx, () => createDealer(staffOf(fx, fx.adminA), fields({ name: `TEST Other ${t}`, supplierId: "sup-elsewhere" }))))
      .toMatchObject({ status: 422 })
    expect(await inTenant(fx, () => createDealer(staffOf(fx, fx.adminA), fields({ name: `TEST Other ${t}`, supplierId: fx.supplier }))))
      .toEqual({ kind: "refused", status: 409, error: "That supplier is already linked to another dealer" })
  })

  it("edits the details: a VAT number makes it a VAT vendor and back, old and new values audited", async () => {
    expect(await inTenant(fx, () => updateDealer(staffOf(fx, fx.adminB), dealerId, { vatNumber: "4000000011" }))).toEqual({ kind: "updated" })
    expect(sql(`SELECT "vatNumber", "vatVendor" FROM "Dealer" WHERE "id" = ${lit(dealerId)}`)).toBe("4000000011|t")
    expect(sql(`SELECT "userId", "oldValue"->>'vatVendor', "newValue"->>'vatVendor' FROM "AuditLog" WHERE "entityId" = ${lit(dealerId)}
      AND "action" = 'DEALER_UPDATED'`)).toBe(`${fx.adminB}|false|true`)
    await inTenant(fx, () => updateDealer(staffOf(fx, fx.adminB), dealerId, { vatNumber: null }))
    expect(sql(`SELECT "vatVendor" FROM "Dealer" WHERE "id" = ${lit(dealerId)}`)).toBe("f")
    expect(await inTenant(fx, () => updateDealer(staffOf(fx, fx.adminB), "no-such-dealer", { contactPhone: "+27110000000" }))).toMatchObject({ status: 404 })
  })

  it("creates the first dealer admin with a one-time link: only the token's hash is stored, never the token in the audit", async () => {
    const created = await inTenant(fx, () => createDealerUser({ kind: "staff", staff: staffOf(fx, fx.adminA) }, dealerId, {
      email: `first-admin-${t}@broker.invalid`, name: "TEST First Admin", role: "DEALER_ADMIN",
    }))
    if (created.kind !== "created") throw new Error(JSON.stringify(created))
    expect(sql(`SELECT "role", "createdByUserId", "passwordHash" IS NULL, "setPasswordTokenHash" FROM "DealerUser" WHERE "id" = ${lit(created.userId)}`))
      .toBe(`DEALER_ADMIN|${fx.adminA}|t|${hashDealerToken(created.token)}`)
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "tenantId" = ${lit(fx.tenantId)} AND "newValue"::text LIKE ${lit(`%${created.token}%`)}`)).toBe("0")
  })

  it("keeps rate history for the dealer and the tenant default; a date is taken once and rows are never edited", async () => {
    const staff = staffOf(fx, fx.adminA)
    expect(await inTenant(fx, () => setCommissionRate(staff, dealerId, { effectiveFrom: "2026-01-01", bps: 200, flatCents: 0 }))).toMatchObject({ kind: "created" })
    expect(await inTenant(fx, () => setCommissionRate(staff, dealerId, { effectiveFrom: "2026-07-01", bps: 300, flatCents: 50_000 }))).toMatchObject({ kind: "created" })
    expect(await inTenant(fx, () => setCommissionRate(staff, dealerId, { effectiveFrom: "2026-07-01", bps: 350, flatCents: 0 }))).toMatchObject({ status: 409 })
    const byDefault = await inTenant(fx, () => setCommissionRate(staff, null, { effectiveFrom: "2026-01-01", bps: 100, flatCents: 0 }))
    if (byDefault.kind !== "created") throw new Error(JSON.stringify(byDefault))
    expect(await inTenant(fx, () => setCommissionRate(staff, null, { effectiveFrom: "2026-01-01", bps: 150, flatCents: 0 }))).toMatchObject({ status: 409 })
    expect(sql(`SELECT "bps", "flatCents" FROM "dealerCommissionRateAt"(${lit(fx.tenantId)}, ${lit(dealerId)}, '2026-08-01')`)).toBe("300|50000")
    expect(sql(`SELECT "bps" FROM "dealerCommissionRateAt"(${lit(fx.tenantId)}, ${lit(dealerId)}, '2026-03-01')`)).toBe("200")
    expect(sql(`SELECT "source" FROM "dealerCommissionRateAt"(${lit(fx.tenantId)}, ${lit(fx.dealerB)}, '2026-03-01')`)).toBe("TENANT_DEFAULT")
    expect(sql(`SELECT "userId", "newValue"->>'scope' FROM "AuditLog" WHERE "entityId" = ${lit(byDefault.rateId)} AND "action" = 'DEALER_COMMISSION_RATE_SET'`))
      .toBe(`${fx.adminA}|TENANT_DEFAULT`)
  })

  it("captures a bank account PENDING (audit without the number); the requester cannot decide it; a second user approves", async () => {
    const requested = await inTenant(fx, () => requestDealerBankAccount(staffOf(fx, fx.officer), dealerId, account))
    if (requested.kind !== "requested") throw new Error(JSON.stringify(requested))
    const id = requested.account.id
    expect(requested.account).toMatchObject({ status: "PENDING", requestedById: fx.officer })
    expect(sql(`SELECT "newValue"->>'accountNumberLast4', "newValue"::text LIKE '%62000000001%' FROM "AuditLog" WHERE "entityId" = ${lit(id)}
      AND "action" = 'DEALER_BANK_ACCOUNT_REQUESTED'`)).toBe("0001|f")
    expect(await decide(id, fx.officer)).toEqual({ kind: "self_decision" })
    expect(await decide(id, fx.adminB)).toMatchObject({ kind: "decided", supersededId: null, account: { status: "APPROVED", decidedById: fx.adminB } })
    expect(sql(`SELECT "avsResult"->>'status', "avsResult"->'manualVerification'->>'note', "avsPassed" IS NULL FROM "DealerBankAccount" WHERE "id" = ${lit(id)}`))
      .toBe("NOT_RUN|TEST bank-stamped letter checked|t")
    expect(audit(id, "DEALER_BANK_ACCOUNT_DECIDED")).toBe(fx.adminB)
    expect(await decide(id, fx.adminA)).toMatchObject({ status: 409 })

    const change = await inTenant(fx, () => requestDealerBankAccount(staffOf(fx, fx.officer), dealerId, { ...account, accountNumber: "62000000002" }))
    const rejected = await inTenant(fx, () => requestDealerBankAccount(staffOf(fx, fx.officer), dealerId, { ...account, accountNumber: "62000000003" }))
    if (change.kind !== "requested" || rejected.kind !== "requested") throw new Error("not requested")
    expect(await decide(rejected.account.id, fx.adminA, "REJECT")).toMatchObject({ kind: "decided", account: { status: "REJECTED" } })
    expect(await decide(change.account.id, fx.adminA)).toMatchObject({ kind: "decided", supersededId: id })
    expect(sql(`SELECT "status" FROM "DealerBankAccount" WHERE "id" = ${lit(id)}`)).toBe("SUPERSEDED")
  })

  it("deactivates the dealer: every user's tokenVersion bumped and links cleared; nothing more is added to it", async () => {
    const before = sql(`SELECT sum("tokenVersion") FROM "DealerUser" WHERE "dealerId" = ${lit(dealerId)}`)
    expect(await inTenant(fx, () => deactivateDealer(staffOf(fx, fx.adminA), dealerId))).toEqual({ kind: "deactivated", usersRevoked: 1 })
    expect(Number(sql(`SELECT sum("tokenVersion") FROM "DealerUser" WHERE "dealerId" = ${lit(dealerId)}`))).toBe(Number(before) + 1)
    expect(sql(`SELECT count(*) FROM "DealerUser" WHERE "dealerId" = ${lit(dealerId)} AND "setPasswordTokenHash" IS NOT NULL`)).toBe("0")
    expect(sql(`SELECT "active", "deactivatedById" FROM "Dealer" WHERE "id" = ${lit(dealerId)}`)).toBe(`f|${fx.adminA}`)
    expect(audit(dealerId, "DEALER_DEACTIVATED")).toBe(fx.adminA)
    const staff = staffOf(fx, fx.adminA)
    expect(await inTenant(fx, () => setCommissionRate(staff, dealerId, { effectiveFrom: "2026-12-01", bps: 1, flatCents: 0 }))).toMatchObject({ status: 409 })
    expect(await inTenant(fx, () => requestDealerBankAccount(staff, dealerId, account))).toMatchObject({ status: 409 })
    expect(await inTenant(fx, () => updateDealer(staff, dealerId, { contactPhone: "+27110000000" }))).toMatchObject({ status: 409 })
    expect(await inTenant(fx, () => deactivateDealer(staff, dealerId))).toMatchObject({ status: 409 })
  })

  it("the settings route answers the demo-only CHECK 422 on a lender that is not a demo, and writes nothing", async () => {
    sql(`UPDATE "TenantConfig" SET "featureDealerPortal" = false, "isDemoLender" = false WHERE "tenantId" = ${lit(fx.tenantId)}`)
    session.current = { user: { id: fx.adminA, email: "admin-a@staff.invalid", role: "ADMIN", tenantId: fx.tenantId } }
    const patch = (body: unknown) => settingsPatch(new NextRequest(`http://${fx.host}/api/settings/asset-finance`, {
      method: "PATCH", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify(body),
    }))
    const refused = await patch({ featureDealerPortal: true })
    expect(refused.status).toBe(422)
    expect((await refused.json()).error).toMatch(/only for a demo lender/)
    expect(sql(`SELECT "featureDealerPortal" FROM "TenantConfig" WHERE "tenantId" = ${lit(fx.tenantId)}`)).toBe("f")
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "tenantId" = ${lit(fx.tenantId)} AND "action" = 'DEALER_PORTAL_ENABLED'`)).toBe("0")
    const months = await patch({ dealerCommissionClawbackMonths: 6 })
    expect(months.status).toBe(200)
    expect(sql(`SELECT "dealerCommissionClawbackMonths" FROM "TenantConfig" WHERE "tenantId" = ${lit(fx.tenantId)}`)).toBe("6")
    expect(sql(`SELECT "userId" FROM "AuditLog" WHERE "tenantId" = ${lit(fx.tenantId)} AND "action" = 'DEALER_CLAWBACK_MONTHS_CHANGED'`)).toBe(fx.adminA)
    session.current = null
  })
})
