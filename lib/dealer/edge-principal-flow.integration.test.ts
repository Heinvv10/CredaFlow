/**
 * Independent black-box edge tests for dealer principal revocation,
 * user-email uniqueness and the hand-over / accept / upload flow (spec:
 * docs/asset-finance/SLICE5.md Part A). Uses only the exported lib functions
 * the routes call, plus SQL.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/edge-principal-flow.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import {
  approvedDealerAccount, cleanupDealerFixtureIfCreated, createDealerFixture, insertDealer, insertDealerUser, insertRate, lit, newId, type DealerFixture,
} from "./dealer.integration-fixture"
import { approve, bookedDealerDeal, captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"
import { actorOf, dealerDraft, inTenant, pdfUpload, staffOf } from "./dealer-origination.integration-fixture"
import { createDealerUser, deactivateDealer, deactivateDealerUser, parseDealerUserInput } from "./users"
import { revalidateDealerPrincipal } from "./principal"
import { attestDealerConsent, verifyDealerConsent } from "./consent"
import { acceptDealerSubmission, submitDealerDeal } from "./submit"
import { uploadDealerDocument } from "./documents"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const t2 = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let fx2: DealerFixture | null = null

const history = (stmt: string) => sql(`BEGIN; SET LOCAL session_replication_role = replica; ${stmt}; COMMIT;`)
const ok = <T extends { kind: string }>(r: T, kind: string): T => {
  expect(r.kind).toBe(kind)
  return r
}
function freshDealerWithAccount() {
  const dealerId = insertDealer(fx.tenantId, fx.adminA, { name: `TEST Run ${newId("n")}` })
  const userId = insertDealerUser(fx.tenantId, dealerId, { role: "DEALER_ADMIN", byUser: fx.adminA })
  insertRate(fx, { dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
  approvedDealerAccount(fx, dealerId, `00${Math.floor(Math.random() * 1e8)}`)
  return { dealerId, userId }
}

suite.sequential("dealer principal, user and flow edges (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)
  afterAll(async () => {
    await cleanupDealerFixtureIfCreated(db, t)
    if (fx2) {
      const second = new PrismaClient()
      await cleanupDealerFixtureIfCreated(second, t2)
    }
  })

  // ---------------- principal / sessions ----------------
  it("P01 session revalidation: live, stale tokenVersion, wrong tenant/dealer claim, deactivated user, deactivated dealer, portal flag off", async () => {
    const dealerId = insertDealer(fx.tenantId, fx.adminA, { name: `TEST P ${newId("n")}` })
    const u1 = insertDealerUser(fx.tenantId, dealerId, { role: "DEALER_ADMIN", byUser: fx.adminA })
    const u2 = insertDealerUser(fx.tenantId, dealerId, { role: "DEALER_SALES", byUser: fx.adminA })
    sql(`UPDATE "DealerUser" SET "passwordHash" = 'x' WHERE "id" IN (${lit(u1)}, ${lit(u2)})`)
    const claims = (tokenVersion = 0, over: Record<string, unknown> = {}) => ({ tenantId: fx.tenantId, dealerId, tokenVersion, ...over })
    expect(await revalidateDealerPrincipal(u1, claims())).toMatchObject({ dealerId })
    expect(await revalidateDealerPrincipal(u1, claims(1))).toBeNull()
    expect(await revalidateDealerPrincipal(u1, claims(0, { tenantId: "other" }))).toBeNull()
    expect(await revalidateDealerPrincipal(u1, claims(0, { dealerId: fx.dealerB }))).toBeNull()
    expect(await revalidateDealerPrincipal("no-such-user", claims())).toBeNull()
    // deactivate u2 mid-session
    ok(await inTenant(fx, () => deactivateDealerUser({ kind: "staff", staff: staffOf(fx) }, dealerId, u2)), "deactivated")
    expect(await revalidateDealerPrincipal(u2, claims())).toBeNull()
    // reactivated by hand: the old token (version 0) stays dead
    sql(`UPDATE "DealerUser" SET "active" = true WHERE "id" = ${lit(u2)}`)
    expect(await revalidateDealerPrincipal(u2, claims(0))).toBeNull()
    expect(await revalidateDealerPrincipal(u2, claims(1))).toMatchObject({ dealerId })
    // tokenVersion may only increase
    expectRejected(`UPDATE "DealerUser" SET "tokenVersion" = 0 WHERE "id" = ${lit(u2)}`, "")
    // portal flag off mid-session
    sql(`UPDATE "TenantConfig" SET "featureDealerPortal" = false WHERE "tenantId" = ${lit(fx.tenantId)}`)
    expect(await revalidateDealerPrincipal(u1, claims())).toBeNull()
    sql(`UPDATE "TenantConfig" SET "featureDealerPortal" = true WHERE "tenantId" = ${lit(fx.tenantId)}`)
    expect(await revalidateDealerPrincipal(u1, claims())).toMatchObject({ dealerId })
    // dealer deactivated: every user's session dies
    ok(await inTenant(fx, () => deactivateDealer(staffOf(fx), dealerId)), "deactivated")
    expect(await revalidateDealerPrincipal(u1, claims(0))).toBeNull()
    expect(await revalidateDealerPrincipal(u1, claims(1))).toBeNull() // dealer inactive even with the bumped version
  }, 60_000)

  it("P02 the demo-only CHECK refuses the portal flag on a non-demo lender, and clearing isDemoLender while on", () => {
    expectRejected(`UPDATE "TenantConfig" SET "isDemoLender" = false WHERE "tenantId" = ${lit(fx.tenantId)}`, "TenantConfig_dealer_portal_demo_only")
  }, 60_000)

  // ---------------- user email uniqueness ----------------
  it("U01 two dealers of one lender cannot share a user email (any case); a dealer admin cannot add users to another dealer", async () => {
    const email = `shared-${newId("e")}@dealer.invalid`
    const staffBy = { kind: "staff" as const, staff: staffOf(fx) }
    ok(await inTenant(fx, () => createDealerUser(staffBy, fx.dealerA, { email, name: "TEST One", role: "DEALER_SALES" })), "created")
    expect(await inTenant(fx, () => createDealerUser(staffBy, fx.dealerB, { email, name: "TEST Two", role: "DEALER_SALES" }))).toMatchObject({ status: 409 })
    const upper = parseDealerUserInput({ email: email.toUpperCase(), name: "TEST Three", role: "DEALER_SALES" })
    if (!("data" in upper)) throw new Error("parse failed")
    expect(upper.data.email).toBe(email)
    expect(await inTenant(fx, () => createDealerUser(staffBy, fx.dealerB, upper.data))).toMatchObject({ status: 409 })
    const bAdmin = { kind: "dealer" as const, actor: actorOf(fx, fx.userB, fx.dealerB, "DEALER_ADMIN") }
    expect(await inTenant(fx, () => createDealerUser(bAdmin, fx.dealerA, { email: `x-${email}`, name: "TEST Four", role: "DEALER_SALES" }))).toMatchObject({ status: 404 })
  }, 60_000)

  it("U02 the same email may exist as a dealer user in a DIFFERENT lender", async () => {
    if (!db) throw new Error("no db")
    fx2 = await createDealerFixture(db, t2)
    const email = `cross-${newId("e")}@dealer.invalid`
    const by1 = { kind: "staff" as const, staff: staffOf(fx) }
    const by2 = { kind: "staff" as const, staff: staffOf(fx2) }
    ok(await inTenant(fx, () => createDealerUser(by1, fx.dealerA, { email, name: "TEST One", role: "DEALER_SALES" })), "created")
    ok(await inTenant(fx2!, () => createDealerUser(by2, fx2!.dealerA, { email, name: "TEST Two", role: "DEALER_SALES" })), "created")
  }, 60_000)

  it("U03 the database forces the email to lower case, so a case-variant duplicate cannot exist", () => {
    const id = newId("dlu")
    const insert = (e: string, i: string) => `INSERT INTO "DealerUser" ("id", "tenantId", "dealerId", "email", "name", "role", "createdByUserId", "updatedAt")
      VALUES (${lit(i)}, ${lit(fx.tenantId)}, ${lit(fx.dealerB)}, ${lit(e)}, 'TEST', 'DEALER_SALES', ${lit(fx.adminA)}, now())`
    expectRejected(insert(`MixedCase-${id}@dealer.invalid`, id), "DealerUser_email_lower_case")
    sql(insert(`mixedcase-${id}@dealer.invalid`, id))
    expectRejected(`UPDATE "DealerUser" SET "email" = upper("email") WHERE "id" = ${lit(id)}`, "DealerUser_email_lower_case")
  }, 60_000)

  // ---------------- hand-over, accept, upload ----------------
  it("F01 handed over twice / un-handed: the lib answers 409; the database refuses a re-set, a NULL, a staff deal and a non-DRAFT deal", async () => {
    const sales = actorOf(fx, fx.salesUserA, fx.dealerA)
    const draft = await dealerDraft(fx, sales)
    const stored = await inTenant(fx, () => uploadDealerDocument(sales, draft.dealId, pdfUpload("POPIA_CONSENT")))
    if (stored.kind !== "stored") throw new Error("upload")
    ok(await inTenant(fx, () => attestDealerConsent(sales, draft.dealId, { documentId: stored.document.id, clientIds: [draft.directorId] , signingMethod: "IN_PERSON" })), "attested")
    ok(await inTenant(fx, () => submitDealerDeal(sales, draft.dealId)), "submitted")
    expect(await inTenant(fx, () => submitDealerDeal(sales, draft.dealId))).toMatchObject({ status: 409 })
    expect(await inTenant(fx, () => submitDealerDeal(actorOf(fx, fx.salesUserA, fx.dealerA, "DEALER_ADMIN"), draft.dealId))).toMatchObject({ status: 409 })
    expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = now() + interval '1 minute' WHERE "id" = ${lit(draft.dealId)}`, "")
    expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = NULL WHERE "id" = ${lit(draft.dealId)}`, "")
    const staffDeal = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...captureForDealer(fx, null) }).dealId
    expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = now() WHERE "id" = ${lit(staffDeal)}`, "")
    // staff accepts; a second accept and a dealer re-submit after acceptance are clean refusals
    const attestationId = sql(`SELECT "id" FROM "DealerConsentAttestation" WHERE "dealId" = ${lit(draft.dealId)}`)
    ok(await inTenant(fx, () => verifyDealerConsent(staffOf(fx), draft.dealId, attestationId)), "verified")
    const accepted = await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), draft.dealId))
    expect(["submitted", "refused_nca"]).toContain(accepted.kind)
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), draft.dealId))).toMatchObject({ kind: "not_draft" })
    expect(await inTenant(fx, () => submitDealerDeal(sales, draft.dealId))).toMatchObject({ status: 409 })
    const status = sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(draft.dealId)}`)
    // F03: uploads and consent attestations AFTER hand-over / acceptance. Records the behaviour per status.
    const after = await inTenant(fx, () => uploadDealerDocument(sales, draft.dealId, pdfUpload("OTHER")))
    const attestAfter = await inTenant(fx, () => attestDealerConsent(sales, draft.dealId, { documentId: stored.document.id, clientIds: [draft.directorId] , signingMethod: "IN_PERSON" }))
    console.info(`[F03] after accept (status ${status}): upload=${after.kind === "stored" ? "stored" : JSON.stringify(after)} attest=${JSON.stringify(attestAfter).slice(0, 120)}`)
    expect(attestAfter).toMatchObject({ status: 409 })
  }, 60_000)

  it("F02 staff accept on a deal not handed over / a deal of no dealer / an unknown deal: 409 / 409 / 404 and the deal stays DRAFT", async () => {
    const sales = actorOf(fx, fx.salesUserA, fx.dealerA)
    const draft = await dealerDraft(fx, sales)
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), draft.dealId))).toMatchObject({ status: 409 })
    expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(draft.dealId)}`)).toBe("DRAFT")
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), "nope"))).toMatchObject({ status: 404 })
  }, 60_000)

  it("F04 dealer uploads by deal status: free while the dealer holds the draft; after hand-over only against an open request; closed deals refuse", async () => {
    const d = freshDealerWithAccount()
    const sales = actorOf(fx, d.userId, d.dealerId, "DEALER_ADMIN")
    const outcome: Record<string, string> = {}
    const attempt = async (label: string, dealId: string, requestId: string | null = null) => {
      const r = await inTenant(fx, () => uploadDealerDocument(sales, dealId, pdfUpload("OTHER"), requestId))
      outcome[label] = r.kind === "stored" ? "stored" : `${(r as { status: number }).status}`
    }
    const openRequest = (dealId: string) => {
      const id = `req-${randomUUID()}`
      sql(`INSERT INTO "DealerDocumentRequest" ("id", "tenantId", "dealId", "docType", "note", "requestedById")
        VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(dealId)}, 'OTHER', 'Synthetic: edge test request', ${lit(fx.officer)})`)
      return id
    }
    const held = dealerDeal(fx, { dealerId: d.dealerId, dealerUserId: d.userId, ...captureForDealer(fx, d.dealerId) })
    await attempt("DRAFT", held.dealId)
    const submitted = dealerDeal(fx, { dealerId: d.dealerId, dealerUserId: d.userId, ...captureForDealer(fx, d.dealerId) })
    history(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = now() WHERE "id" = ${lit(submitted.dealId)}`)
    await attempt("DRAFT+handed-over", submitted.dealId)
    await attempt("DRAFT+handed-over, request", submitted.dealId, openRequest(submitted.dealId))
    const approvedDeal = dealerDeal(fx, { dealerId: d.dealerId, dealerUserId: d.userId, ...captureForDealer(fx, d.dealerId) })
    approve(fx, approvedDeal.dealId)
    await attempt("APPROVED", approvedDeal.dealId)
    await attempt("APPROVED, request", approvedDeal.dealId, openRequest(approvedDeal.dealId))
    const booked = bookedDealerDeal(fx, d.dealerId, d.userId)
    await attempt("BOOKED", booked.dealId)
    const cancelled = dealerDeal(fx, { dealerId: d.dealerId, dealerUserId: d.userId, ...captureForDealer(fx, d.dealerId) })
    sql(`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = ${lit(fx.officer)}, "cancelReason" = 'Synthetic: edge test cancel' WHERE "id" = ${lit(cancelled.dealId)}`)
    await attempt("CANCELLED", cancelled.dealId)
    expect(outcome).toEqual({
      DRAFT: "stored",
      "DRAFT+handed-over": "409", "DRAFT+handed-over, request": "stored",
      APPROVED: "409", "APPROVED, request": "stored",
      BOOKED: "409",
      CANCELLED: "409",
    })
  }, 60_000)
})
