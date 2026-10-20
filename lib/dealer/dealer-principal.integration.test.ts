/**
 * Real-Postgres proof of the dealer principal (lib/dealer/sign-in.ts,
 * principal.ts, users.ts, password-links.ts): a user created by staff sets a
 * password through the one-time link and signs in on the host's lender; every
 * request re-applies the rules, so deactivating the user or the dealer, a
 * staff reset link, the portal switched off, or the lender suspended ends
 * the session on its next request.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-principal.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, type DealerFixture } from "./dealer.integration-fixture"
import { authorizeDealer } from "./sign-in"
import { revalidateDealerPrincipal } from "./principal"
import { createDealerUser, deactivateDealer, deactivateDealerUser } from "./users"
import { issueDealerPasswordLink, setDealerPassword } from "./password-links"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let host: string
const PASSWORD = "TEST synthetic dealer passphrase 7"

const staff = () => ({ kind: "staff" as const, staff: { tenantId: fx.tenantId, userId: fx.adminA, userEmail: "admin-a@staff.invalid" } })
const scoped = <T>(fn: () => Promise<T>) => runWithTenant(fx.tenantId, fn)
const signIn = (email: string, password = PASSWORD) => authorizeDealer({
  email, password, code: undefined,
  request: new Request(`https://${host}/api/auth/callback/credentials`, { headers: { host } }),
  recordFailure: async () => undefined, equalizeTiming: async () => undefined,
})
const claims = (user: { tenantId: string; dealerId: string; tokenVersion: number }) => ({ tenantId: user.tenantId, dealerId: user.dealerId, tokenVersion: user.tokenVersion })

/** A new user of `dealerId` with a password set through its link; returns its signed-in shape. */
async function activeUser(dealerId: string, role: "DEALER_ADMIN" | "DEALER_SALES" = "DEALER_SALES") {
  const email = `${randomUUID().slice(0, 8)}@dealer.invalid`
  const created = await scoped(() => createDealerUser(staff(), dealerId, { email, name: "TEST Dealer User", role }))
  if (created.kind !== "created") throw new Error(created.error)
  expect(await setDealerPassword({ tenantId: fx.tenantId, token: created.token, password: PASSWORD })).toEqual({ kind: "set" })
  const result = await signIn(email)
  if (!result.ok) throw new Error("sign-in refused")
  return result.user
}

suite.sequential("dealer principal (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    host = sql(`SELECT "domain" FROM "Tenant" WHERE "id" = ${lit(fx.tenantId)}`)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("creates a user with a one-time link, sets the password once, signs in and audits it", async () => {
    const email = `${randomUUID().slice(0, 8)}@dealer.invalid`
    const created = await scoped(() => createDealerUser(staff(), fx.dealerA, { email, name: "TEST Dealer User", role: "DEALER_SALES" }))
    if (created.kind !== "created") throw new Error(created.error)
    expect((await signIn(email)).ok).toBe(false)
    expect(await setDealerPassword({ tenantId: "another-tenant", token: created.token, password: PASSWORD })).toMatchObject({ status: 400 })
    expect(await setDealerPassword({ tenantId: fx.tenantId, token: created.token, password: "password1" })).toMatchObject({ status: 400 })
    expect(await setDealerPassword({ tenantId: fx.tenantId, token: created.token, password: PASSWORD })).toEqual({ kind: "set" })
    expect(await setDealerPassword({ tenantId: fx.tenantId, token: created.token, password: PASSWORD })).toMatchObject({ status: 400 })
    expect(sql(`SELECT "setPasswordTokenHash" IS NULL, "tokenVersion" FROM "DealerUser" WHERE "id" = ${lit(created.userId)}`)).toBe("t|1")
    const result = await signIn(email)
    expect(result).toMatchObject({ ok: true, user: { id: created.userId, role: "DEALER", tenantId: fx.tenantId, dealerId: fx.dealerA, tokenVersion: 1 } })
    expect((await signIn(email, "TEST wrong passphrase 99")).ok).toBe(false)
    expect(sql(`SELECT "lastLoginAt" IS NOT NULL FROM "DealerUser" WHERE "id" = ${lit(created.userId)}`)).toBe("t")
    expect(sql(`SELECT "userId" IS NULL, "newValue"->'actor'->>'type' FROM "AuditLog"
      WHERE "tenantId" = ${lit(fx.tenantId)} AND "action" = 'DEALER_SIGNED_IN' AND "entityId" = ${lit(created.userId)}`)).toBe("t|dealer")
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "tenantId" = ${lit(fx.tenantId)} AND "newValue"::text LIKE ${lit(`%${created.token}%`)}`)).toBe("0")
  })

  it("refuses an expired link", async () => {
    const created = await scoped(() => createDealerUser(staff(), fx.dealerA, { email: `${randomUUID().slice(0, 8)}@dealer.invalid`, name: "TEST", role: "DEALER_SALES" }))
    if (created.kind !== "created") throw new Error(created.error)
    const later = new Date(created.expiresAt.getTime() + 1000)
    expect(await setDealerPassword({ tenantId: fx.tenantId, token: created.token, password: PASSWORD }, later)).toMatchObject({ status: 400 })
  })

  it("ends a session when the user is deactivated", async () => {
    const user = await activeUser(fx.dealerA)
    expect(await revalidateDealerPrincipal(user.id, claims(user))).toMatchObject({ dealerRole: "DEALER_SALES" })
    expect(await scoped(() => deactivateDealerUser(staff(), fx.dealerA, user.id))).toEqual({ kind: "deactivated" })
    expect(await revalidateDealerPrincipal(user.id, claims(user))).toBeNull()
    expect((await signIn(user.email)).ok).toBe(false)
  })

  it("lets a dealer admin deactivate its own dealer's users only, never itself", async () => {
    const admin = await activeUser(fx.dealerA, "DEALER_ADMIN")
    const actor = { tenantId: fx.tenantId, dealerId: fx.dealerA, dealerUserId: admin.id, email: admin.email, dealerRole: "DEALER_ADMIN" as const }
    const by = { kind: "dealer" as const, actor }
    const theirs = await activeUser(fx.dealerB)
    expect(await scoped(() => deactivateDealerUser(by, fx.dealerB, theirs.id))).toMatchObject({ status: 404 })
    expect(await scoped(() => deactivateDealerUser(by, fx.dealerA, theirs.id))).toMatchObject({ status: 404 })
    expect(await scoped(() => deactivateDealerUser(by, fx.dealerA, admin.id))).toMatchObject({ status: 409 })
    const created = await scoped(() => createDealerUser(by, fx.dealerA, { email: `${randomUUID().slice(0, 8)}@dealer.invalid`, name: "TEST", role: "DEALER_SALES" }))
    expect(created).toMatchObject({ kind: "created" })
    if (created.kind === "created") {
      expect(sql(`SELECT "createdByDealerUserId", "createdByUserId" IS NULL FROM "DealerUser" WHERE "id" = ${lit(created.userId)}`)).toBe(`${admin.id}|t`)
      expect(await scoped(() => deactivateDealerUser(by, fx.dealerA, created.userId))).toEqual({ kind: "deactivated" })
    }
    expect(await scoped(() => createDealerUser(by, fx.dealerB, { email: `${randomUUID().slice(0, 8)}@dealer.invalid`, name: "TEST", role: "DEALER_SALES" })))
      .toMatchObject({ status: 404 })
  })

  it("ends a session on a staff reset link", async () => {
    const user = await activeUser(fx.dealerA)
    const link = await scoped(() => issueDealerPasswordLink(staff().staff, fx.dealerA, user.id))
    expect(link).toMatchObject({ kind: "issued" })
    expect(await revalidateDealerPrincipal(user.id, claims(user))).toBeNull()
  })

  it("ends a session when the portal is switched off, and again while the lender is suspended", async () => {
    const user = await activeUser(fx.dealerA)
    sql(`UPDATE "TenantConfig" SET "featureDealerPortal" = false WHERE "tenantId" = ${lit(fx.tenantId)}`)
    expect(await revalidateDealerPrincipal(user.id, claims(user))).toBeNull()
    sql(`UPDATE "TenantConfig" SET "featureDealerPortal" = true WHERE "tenantId" = ${lit(fx.tenantId)}`)
    expect(await revalidateDealerPrincipal(user.id, claims(user))).toMatchObject({ dealerRole: "DEALER_SALES" })
    sql(`UPDATE "Tenant" SET "status" = 'SUSPENDED' WHERE "id" = ${lit(fx.tenantId)}`)
    try {
      expect(await revalidateDealerPrincipal(user.id, claims(user))).toBeNull()
    } finally {
      sql(`UPDATE "Tenant" SET "status" = 'ACTIVE' WHERE "id" = ${lit(fx.tenantId)}`)
    }
  })

  it("ends every session of a dealer that is deactivated, in one transaction", async () => {
    const one = await activeUser(fx.dealerB)
    const two = await activeUser(fx.dealerB, "DEALER_ADMIN")
    const result = await scoped(() => deactivateDealer(staff().staff, fx.dealerB))
    expect(result).toMatchObject({ kind: "deactivated" })
    expect(await revalidateDealerPrincipal(one.id, claims(one))).toBeNull()
    expect(await revalidateDealerPrincipal(two.id, claims(two))).toBeNull()
    expect(await scoped(() => createDealerUser(staff(), fx.dealerB, { email: `${randomUUID().slice(0, 8)}@dealer.invalid`, name: "TEST", role: "DEALER_SALES" })))
      .toMatchObject({ status: 409 })
    // The versions were bumped too: reactivating the dealer by hand revives no old session.
    sql(`UPDATE "Dealer" SET "active" = true WHERE "id" = ${lit(fx.dealerB)}`)
    expect(await revalidateDealerPrincipal(two.id, claims(two))).toBeNull()
    expect(await revalidateDealerPrincipal(two.id, { ...claims(two), tokenVersion: two.tokenVersion + 1 })).toMatchObject({ dealerRole: "DEALER_ADMIN" })
  })
})
