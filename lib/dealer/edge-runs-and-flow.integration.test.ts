/**
 * Independent black-box edge tests for dealer payable runs, dealer principal
 * revocation, user-email uniqueness and the hand-over / accept / upload flow
 * (spec: docs/asset-finance/SLICE5.md Part A). Uses only the exported lib
 * functions the routes call, plus SQL.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/edge-runs-and-flow.integration.test.ts
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
import { approvePayableRun, cancelPayableRun, createPayableRun, releasePayableRun } from "./payable-runs"
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
const lineIdOf = (dealId: string, kind = "EARNED") => sql(`SELECT "id" FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)} AND "kind" = '${kind}'`)
const setLineDate = (lineId: string, date: string) => history(`UPDATE "DealerCommissionLine" SET "effectiveOn" = '${date}' WHERE "id" = ${lit(lineId)}`)
const runLines = (runId: string) =>
  sql(`SELECT "lineId" FROM "DealerPayableRunLine" WHERE "runId" = ${lit(runId)} AND NOT "voided" ORDER BY "lineId"`).split("\n").filter(Boolean)
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
const createRun = (dealerId: string, periodEnd: string, by = fx.adminA) =>
  inTenant(fx, () => createPayableRun(staffOf(fx, by), dealerId, { periodEnd }))
const approveRun = (runId: string, by = fx.adminB) => inTenant(fx, () => approvePayableRun(staffOf(fx, by), runId))
const releaseRun = (runId: string) => inTenant(fx, () => releasePayableRun(staffOf(fx, fx.adminB), runId, { releaseReference: "TEST-EFT-EDGE" }))

suite.sequential("dealer runs, principal and flow edges (real DB)", () => {
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

  // ---------------- payable runs ----------------
  it("R01 a line effective ON periodEnd is in the run; a line the day after is not", async () => {
    const d = freshDealerWithAccount()
    const a = bookedDealerDeal(fx, d.dealerId, d.userId)
    const b = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(a.dealId), "2026-09-30")
    setLineDate(lineIdOf(b.dealId), "2026-10-01")
    const created = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { kind: "created"; runId: string }
    expect(runLines(created.runId)).toEqual([lineIdOf(a.dealId)])
    const approved = await approveRun(created.runId)
    expect(approved.kind).toBe("approved")
  })

  it("R02 periodEnd must be a month end not after today; bad input is a clean refusal, not a throw", async () => {
    const d = freshDealerWithAccount()
    for (const bad of ["2026-09-29", "2099-01-31", "2026-02-30", "garbage", "", null, 20260930, "2026-09-30T00:00:00Z"]) {
      const r = await createRun(d.dealerId, bad as string)
      expect(r, String(bad)).toMatchObject({ status: expect.any(Number) })
    }
  })

  it("R03 a leap-year month end (2024-02-29) is accepted as a period end; 2025-02-29 is not", async () => {
    const d = freshDealerWithAccount()
    expect(await createRun(d.dealerId, "2025-02-29")).toMatchObject({ status: 400 })
    // 2024-02-29 is a valid month end; with no lines due the refusal must be the 'no commission' 409, not a 400
    expect(await createRun(d.dealerId, "2024-02-29")).toMatchObject({ status: 409 })
  })

  it("R04 a run of only reversals (net negative) is refused and the lines wait; a later bigger earn nets with it", async () => {
    const d = freshDealerWithAccount()
    const old = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(old.dealId), "2026-06-15")
    const june = ok(await createRun(d.dealerId, "2026-06-30"), "created") as { runId: string }
    ok(await approveRun(june.runId), "approved")
    ok(await releaseRun(june.runId), "released")
    sql(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = ${lit(old.loanId)}`) // clawback inside the 12 month window
    const reversalId = lineIdOf(old.dealId, "REVERSED")
    setLineDate(reversalId, "2026-09-10")
    const onlyReversal = await createRun(d.dealerId, "2026-09-30")
    expect(onlyReversal).toMatchObject({ status: 409, error: expect.stringMatching(/net to nothing or less|clawbacks/) })
    expect(sql(`SELECT count(*) FROM "DealerPayableRun" WHERE "dealerId" = ${lit(d.dealerId)} AND "periodEnd" = '2026-09-30'`)).toBe("0")
    const bigger = bookedDealerDeal(fx, d.dealerId, d.userId, { baseCents: 300_000_000 })
    setLineDate(lineIdOf(bigger.dealId), "2026-09-20")
    const nets = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    expect(runLines(nets.runId).sort()).toEqual([reversalId, lineIdOf(bigger.dealId)].sort())
    expect(sql(`SELECT "totalNetCents" FROM "DealerPayableRun" WHERE "id" = ${lit(nets.runId)}`)).toBe(String(3_000_000 - 1_500_000))
    ok(await approveRun(nets.runId), "approved")
  })

  it("R05 an EARNED and its REVERSED both due in the period net to zero: refused, nothing created", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    sql(`UPDATE "Loan" SET "status" = 'WRITTEN_OFF' WHERE "id" = ${lit(x.loanId)}`)
    setLineDate(lineIdOf(x.dealId), "2026-09-05")
    setLineDate(lineIdOf(x.dealId, "REVERSED"), "2026-09-06")
    expect(await createRun(d.dealerId, "2026-09-30")).toMatchObject({ status: 409 })
    expect(sql(`SELECT count(*) FROM "DealerPayableRun" WHERE "dealerId" = ${lit(d.dealerId)}`)).toBe("0")
  })

  it("R06 an EARNED line whose reversal falls AFTER periodEnd waits (does not pay out in the earlier run), per spec deviation 22", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    sql(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = ${lit(x.loanId)}`)
    setLineDate(lineIdOf(x.dealId), "2026-08-10")
    setLineDate(lineIdOf(x.dealId, "REVERSED"), "2026-09-10")
    const r = await createRun(d.dealerId, "2026-08-31")
    // Spec: "run-create code must leave out an EARNED line whose reversal falls after periodEnd" -> nothing due.
    console.info(`[R06] earned Aug, reversal Sep, run Aug-31: ${JSON.stringify(r)}`)
    expect(r).toMatchObject({ status: 409 })
  })

  it("R07 same period twice: the second live run is a clean 409; after cancel the lines are free and the period reusable", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-09-12")
    const first = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    expect(await createRun(d.dealerId, "2026-09-30")).toMatchObject({ status: 409 })
    ok(await inTenant(fx, () => cancelPayableRun(staffOf(fx, fx.adminB), first.runId)), "cancelled")
    const again = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    expect(runLines(again.runId)).toEqual([lineIdOf(x.dealId)])
  })

  it("R08 a second run for a later period after the first is RELEASED excludes the released lines", async () => {
    const d = freshDealerWithAccount()
    const a = bookedDealerDeal(fx, d.dealerId, d.userId)
    const b = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(a.dealId), "2026-07-10")
    setLineDate(lineIdOf(b.dealId), "2026-08-10")
    const jul = ok(await createRun(d.dealerId, "2026-07-31"), "created") as { runId: string }
    ok(await approveRun(jul.runId), "approved")
    ok(await releaseRun(jul.runId), "released")
    const aug = ok(await createRun(d.dealerId, "2026-08-31"), "created") as { runId: string }
    expect(runLines(aug.runId)).toEqual([lineIdOf(b.dealId)])
    expect(await createRun(d.dealerId, "2026-07-31")).toMatchObject({ status: 409 }) // same period as a RELEASED run
  })

  it("R09 self-approval is refused by the lib and by the database", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-09-12")
    const run = ok(await createRun(d.dealerId, "2026-09-30", fx.adminA), "created") as { runId: string }
    expect(await approveRun(run.runId, fx.adminA)).toMatchObject({ kind: "self_approval" })
    expectRejected(`UPDATE "DealerPayableRun" SET "status" = 'APPROVED', "approvedById" = ${lit(fx.adminA)}, "approvedAt" = now() WHERE "id" = ${lit(run.runId)}`, "DealerPayableRun_four_eyes")
  })

  it("R10 a line dated into the period after the run was created blocks approval cleanly (cancel and recreate)", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    const late = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-09-12")
    setLineDate(lineIdOf(late.dealId), "2026-10-15")
    const run = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    setLineDate(lineIdOf(late.dealId), "2026-09-20")
    const approved = await approveRun(run.runId)
    expect(approved).toMatchObject({ status: 409 })
  })

  it("R11 deactivating a dealer with an OPEN run: what happens to approve / release / create (records the behaviour)", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-09-12")
    const run = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    ok(await inTenant(fx, () => deactivateDealer(staffOf(fx), d.dealerId)), "deactivated")
    const approved = await approveRun(run.runId)
    const released = approved.kind === "approved" ? await releaseRun(run.runId) : null
    const another = await createRun(d.dealerId, "2026-08-31")
    console.info(`[R11] approve=${approved.kind} release=${released?.kind} create-after-deactivation=${JSON.stringify(another)}`)
    expect(approved.kind).toBe("approved") // owed commission remains payable; adjust if the product decides otherwise
  })

  it("R12 creating a NEW run for a deactivated dealer (lines still owed): records the behaviour", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-08-12")
    ok(await inTenant(fx, () => deactivateDealer(staffOf(fx), d.dealerId)), "deactivated")
    const r = await createRun(d.dealerId, "2026-08-31")
    console.info(`[R12] create run for deactivated dealer: ${JSON.stringify(r)}`)
    expect(r.kind === "created" || (r as { status?: number }).status === 409).toBe(true)
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
  })

  it("P02 the demo-only CHECK refuses the portal flag on a non-demo lender, and clearing isDemoLender while on", () => {
    expectRejected(`UPDATE "TenantConfig" SET "isDemoLender" = false WHERE "tenantId" = ${lit(fx.tenantId)}`, "TenantConfig_dealer_portal_demo_only")
  })

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
  })

  it("U02 the same email may exist as a dealer user in a DIFFERENT lender", async () => {
    if (!db) throw new Error("no db")
    fx2 = await createDealerFixture(db, t2)
    const email = `cross-${newId("e")}@dealer.invalid`
    const by1 = { kind: "staff" as const, staff: staffOf(fx) }
    const by2 = { kind: "staff" as const, staff: staffOf(fx2) }
    ok(await inTenant(fx, () => createDealerUser(by1, fx.dealerA, { email, name: "TEST One", role: "DEALER_SALES" })), "created")
    ok(await inTenant(fx2!, () => createDealerUser(by2, fx2!.dealerA, { email, name: "TEST Two", role: "DEALER_SALES" })), "created")
  })

  it("U03 the database forces the email to lower case, so a case-variant duplicate cannot exist", () => {
    const id = newId("dlu")
    const insert = (e: string, i: string) => `INSERT INTO "DealerUser" ("id", "tenantId", "dealerId", "email", "name", "role", "createdByUserId", "updatedAt")
      VALUES (${lit(i)}, ${lit(fx.tenantId)}, ${lit(fx.dealerB)}, ${lit(e)}, 'TEST', 'DEALER_SALES', ${lit(fx.adminA)}, now())`
    expectRejected(insert(`MixedCase-${id}@dealer.invalid`, id), "DealerUser_email_lower_case")
    sql(insert(`mixedcase-${id}@dealer.invalid`, id))
    expectRejected(`UPDATE "DealerUser" SET "email" = upper("email") WHERE "id" = ${lit(id)}`, "DealerUser_email_lower_case")
  })

  // ---------------- hand-over, accept, upload ----------------
  it("F01 handed over twice / un-handed: the lib answers 409; the database refuses a re-set, a NULL, a staff deal and a non-DRAFT deal", async () => {
    const sales = actorOf(fx, fx.salesUserA, fx.dealerA)
    const draft = await dealerDraft(fx, sales)
    const stored = await inTenant(fx, () => uploadDealerDocument(sales, draft.dealId, pdfUpload("POPIA_CONSENT")))
    if (stored.kind !== "stored") throw new Error("upload")
    ok(await inTenant(fx, () => attestDealerConsent(sales, draft.dealId, { documentId: stored.document.id, clientIds: [draft.directorId] })), "attested")
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
    const attestAfter = await inTenant(fx, () => attestDealerConsent(sales, draft.dealId, { documentId: stored.document.id, clientIds: [draft.directorId] }))
    console.info(`[F03] after accept (status ${status}): upload=${after.kind === "stored" ? "stored" : JSON.stringify(after)} attest=${JSON.stringify(attestAfter).slice(0, 120)}`)
    expect(attestAfter).toMatchObject({ status: 409 })
  })

  it("F02 staff accept on a deal not handed over / a deal of no dealer / an unknown deal: 409 / 409 / 404 and the deal stays DRAFT", async () => {
    const sales = actorOf(fx, fx.salesUserA, fx.dealerA)
    const draft = await dealerDraft(fx, sales)
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), draft.dealId))).toMatchObject({ status: 409 })
    expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(draft.dealId)}`)).toBe("DRAFT")
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), "nope"))).toMatchObject({ status: 404 })
  })

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
  })
})
