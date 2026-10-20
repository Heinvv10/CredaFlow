/**
 * Real-Postgres proof of the dealer origination flow through the lib
 * functions the portal routes call: capture (createdByDealerId, dealer audit
 * actor), createDealerDeal (the unchanged createDeal with its dealer
 * parameter; provenance), consent evidence (attest, then staff verify →
 * ClientConsent through lib/consent.ts), the dealer submit (dealerSubmittedAt
 * only) and the staff accept running the unchanged submitDeal as staff.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-submit.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, type DealerFixture } from "./dealer.integration-fixture"
import { captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"
import {
  actorOf, assetBody, companyBody, createdId, dealBody, dealerDraft, inTenant, pdfUpload, personBody, registrationNumber, staffOf,
  type DealerDraft,
} from "./dealer-origination.integration-fixture"
import { ALREADY_ON_BOOK, captureDealerAsset, captureDealerEntity, captureDealerPerson } from "./capture"
import { createDealerDeal } from "./deals"
import { uploadDealerDocument } from "./documents"
import { attestDealerConsent, verifyDealerConsent, DEALER_CONSENT_STATEMENT } from "./consent"
import { acceptDealerSubmission, submitDealerDeal } from "./submit"
import type { DealerActor } from "./actor"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let sales: DealerActor
let draft: DealerDraft

const audit = (entityId: string, action: string) =>
  sql(`SELECT "userId" IS NULL, "newValue"->'actor'->>'dealerUserId' FROM "AuditLog" WHERE "tenantId" = ${lit(fx.tenantId)} AND "entityId" = ${lit(entityId)} AND "action" = '${action}'`)
const consentDoc = async (actor: DealerActor, dealId: string) => {
  const stored = await inTenant(fx, () => uploadDealerDocument(actor, dealId, pdfUpload("POPIA_CONSENT")))
  if (stored.kind !== "stored") throw new Error(stored.error)
  return stored.document.id
}

suite.sequential("dealer origination, consent, submit and accept (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    sales = actorOf(fx, fx.salesUserA, fx.dealerA)
    draft = await dealerDraft(fx, sales)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("captures with the dealer's provenance and audits the dealer, not a user", () => {
    for (const [table, id] of [["BusinessEntity", draft.entityId], ["Client", draft.directorId], ["FinancedAsset", draft.assetId]] as const) {
      expect(sql(`SELECT "createdByDealerId" FROM "${table}" WHERE "id" = ${lit(id)}`), table).toBe(fx.dealerA)
    }
    expect(audit(draft.entityId, "BUSINESS_ENTITY_CREATED")).toBe(`t|${fx.salesUserA}`)
    expect(audit(draft.assetId, "ASSET_CREATED")).toBe(`t|${fx.salesUserA}`)
    expect(audit(draft.directorId, "CLIENT_CREATED")).toBe(`t|${fx.salesUserA}`)
    expect(sql(`SELECT "role" FROM "EntityRelationship" WHERE "entityId" = ${lit(draft.entityId)} AND "clientId" = ${lit(draft.directorId)}`)).toBe("DIRECTOR")
  })

  it("creates the deal through createDeal with the dealer columns", () => {
    expect(sql(`SELECT "dealerId", "dealerUserId", "createdById", "status", "dealerSubmittedAt" IS NULL FROM "AssetFinanceDeal" WHERE "id" = ${lit(draft.dealId)}`))
      .toBe(`${fx.dealerA}|${fx.salesUserA}|${fx.salesUserA}|DRAFT|t`)
    expect(audit(draft.dealId, "ASSET_DEAL_CREATED")).toBe(`t|${fx.salesUserA}`)
  })

  it("refuses a duplicate borrower or asset without showing it, and a borrower or asset the dealer did not capture", async () => {
    const reg = registrationNumber()
    await inTenant(fx, async () => {
      createdId(await captureDealerEntity(sales, companyBody(reg)))
      expect(await captureDealerEntity(sales, companyBody(reg))).toEqual({ kind: "refused", status: 409, error: ALREADY_ON_BOOK })
      const idNumber = sql(`SELECT "idNumber" FROM "Client" WHERE "id" = ${lit(fx.director)}`)
      expect(await captureDealerPerson(sales, personBody({ idNumber }))).toEqual({ kind: "refused", status: 409, error: ALREADY_ON_BOOK })
      const asset = assetBody()
      createdId(await captureDealerAsset(sales, asset))
      expect(await captureDealerAsset(sales, asset)).toEqual({ kind: "refused", status: 409, error: ALREADY_ON_BOOK })
      const staff = captureForDealer(fx, null)
      const theirs = captureForDealer(fx, fx.dealerB)
      const mine = createdId(await captureDealerAsset(sales, assetBody()))
      expect(await createDealerDeal(sales, dealBody(fx, { entityId: staff.entityId }, mine))).toMatchObject({ status: 404 })
      expect(await createDealerDeal(sales, dealBody(fx, { entityId: theirs.entityId }, mine))).toMatchObject({ status: 404 })
      expect(await createDealerDeal(sales, dealBody(fx, { entityId: draft.entityId }, staff.assetId))).toMatchObject({ status: 404 })
      expect(await createDealerDeal(sales, dealBody(fx, { clientId: fx.director }, mine))).toMatchObject({ status: 404 })
      expect(await captureDealerPerson(sales, personBody(), theirs.entityId)).toMatchObject({ status: 404 })
    })
  })

  it("refuses a submit without consent, then without a document; attests consent per person", async () => {
    const other = await dealerDraft(fx, sales)
    expect(await inTenant(fx, () => submitDealerDeal(sales, other.dealId))).toMatchObject({ status: 422, error: expect.stringMatching(/Consent is missing/) })
    const docId = await consentDoc(sales, draft.dealId)
    expect(await inTenant(fx, () => attestDealerConsent(sales, draft.dealId, { documentId: docId, clientIds: [fx.director] }))).toMatchObject({ status: 422 })
    expect(await inTenant(fx, () => attestDealerConsent(sales, other.dealId, { documentId: docId, clientIds: [other.directorId] }))).toMatchObject({ status: 404 })
    const attested = await inTenant(fx, () => attestDealerConsent(sales, draft.dealId, { documentId: docId, clientIds: [draft.directorId] }))
    expect(attested).toMatchObject({ kind: "attested" })
    expect(sql(`SELECT "statementVersion", "statementText" = ${lit(DEALER_CONSENT_STATEMENT)}, "dealerUserId" FROM "DealerConsentAttestation"
      WHERE "dealId" = ${lit(draft.dealId)}`)).toBe(`dealer-consent-v1|t|${fx.salesUserA}`)
    expect(await inTenant(fx, () => attestDealerConsent(sales, draft.dealId, { documentId: docId, clientIds: [draft.directorId] }))).toMatchObject({ status: 409 })
  })

  it("leaves a person the lender added to the dealer's entity to the lender: no dealer attestation, not needed to submit", async () => {
    const mixed = await dealerDraft(fx, sales)
    sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
      VALUES (${lit(`rel-${mixed.dealId}`)}, ${lit(fx.tenantId)}, ${lit(mixed.entityId)}, ${lit(fx.director)}, 'DIRECTOR', true, CURRENT_TIMESTAMP)`)
    const docId = await consentDoc(sales, mixed.dealId)
    expect(await inTenant(fx, () => attestDealerConsent(sales, mixed.dealId, { documentId: docId, clientIds: [fx.director] })))
      .toMatchObject({ status: 422, error: expect.stringMatching(/the lender records/) })
    expect(await inTenant(fx, () => attestDealerConsent(sales, mixed.dealId, { documentId: docId, clientIds: [mixed.directorId] })))
      .toMatchObject({ kind: "attested" })
    expect(await inTenant(fx, () => submitDealerDeal(sales, mixed.dealId))).toMatchObject({ kind: "submitted" })
  })

  it("refuses a staff-accept before the dealer submits", async () => {
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), draft.dealId))).toMatchObject({ status: 409 })
    const staffDeal = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...captureForDealer(fx, null) }).dealId
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), staffDeal))).toMatchObject({ status: 409 })
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), "no-such-deal"))).toMatchObject({ status: 404 })
  })

  it("submits once: dealerSubmittedAt only, the deal stays DRAFT", async () => {
    const result = await inTenant(fx, () => submitDealerDeal(sales, draft.dealId))
    expect(result).toMatchObject({ kind: "submitted" })
    expect(sql(`SELECT "status", "dealerSubmittedAt" IS NOT NULL FROM "AssetFinanceDeal" WHERE "id" = ${lit(draft.dealId)}`)).toBe("DRAFT|t")
    expect(audit(draft.dealId, "DEALER_DEAL_SUBMITTED")).toBe(`t|${fx.salesUserA}`)
    expect(await inTenant(fx, () => submitDealerDeal(sales, draft.dealId))).toMatchObject({ status: 409 })
  })

  it("adds no person to the business once its deal is handed over (the lender's people from then on)", async () => {
    expect(await inTenant(fx, () => captureDealerPerson(sales, personBody(), draft.entityId)))
      .toMatchObject({ kind: "refused", status: 409, error: expect.stringMatching(/handed to the lender/) })
    expect(sql(`SELECT count(*) FROM "EntityRelationship" WHERE "entityId" = ${lit(draft.entityId)}`)).toBe("1")
    // A business whose only dealer deal was cancelled takes people again.
    const other = await dealerDraft(fx, sales)
    sql(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(other.dealId)};
      UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelledById" = ${lit(fx.officer)},
        "cancelReason" = 'Synthetic: cancelled hand-over' WHERE "id" = ${lit(other.dealId)}`)
    expect(await inTenant(fx, () => captureDealerPerson(sales, personBody(), other.entityId))).toMatchObject({ kind: "created" })
  })

  it("staff verify the consent: attestation, document and ClientConsent, once", async () => {
    const attestationId = sql(`SELECT "id" FROM "DealerConsentAttestation" WHERE "dealId" = ${lit(draft.dealId)}`)
    expect(await inTenant(fx, () => verifyDealerConsent(staffOf(fx), draft.dealId, attestationId))).toEqual({ kind: "verified" })
    expect(sql(`SELECT "verifiedById" FROM "DealerConsentAttestation" WHERE "id" = ${lit(attestationId)}`)).toBe(fx.officer)
    expect(sql(`SELECT d."verifiedById" FROM "EntityDocument" d JOIN "DealerConsentAttestation" a ON a."documentId" = d."id" WHERE a."id" = ${lit(attestationId)}`)).toBe(fx.officer)
    expect(sql(`SELECT "creditBureauEnquiry", "capturedBy" FROM "ClientConsent" WHERE "clientId" = ${lit(draft.directorId)}`)).toBe(`t|${fx.officer}`)
    expect(sql(`SELECT "userId" FROM "AuditLog" WHERE "entityId" = ${lit(attestationId)} AND "action" = 'DEALER_CONSENT_VERIFIED'`)).toBe(fx.officer)
    expect(await inTenant(fx, () => verifyDealerConsent(staffOf(fx), draft.dealId, attestationId))).toMatchObject({ status: 409 })
  })

  it("staff accept refuses a borrower without an address: it is fixed at approval and booking needs it", async () => {
    const address = sql(`SELECT "addressLine1" FROM "BusinessEntity" WHERE "id" = ${lit(draft.entityId)}`)
    sql(`UPDATE "BusinessEntity" SET "addressLine1" = NULL WHERE "id" = ${lit(draft.entityId)}`)
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), draft.dealId)))
      .toMatchObject({ kind: "refused", status: 422, error: expect.stringMatching(/address/) })
    expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(draft.dealId)}`)).toBe("DRAFT")
    sql(`UPDATE "BusinessEntity" SET "addressLine1" = ${lit(address)} WHERE "id" = ${lit(draft.entityId)}`)
  })

  it("staff accept runs the unchanged submitDeal as the staff member", async () => {
    const result = await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), draft.dealId))
    expect(["submitted", "refused_nca"]).toContain(result.kind)
    expect(sql(`SELECT "status" <> 'DRAFT' FROM "AssetFinanceDeal" WHERE "id" = ${lit(draft.dealId)}`)).toBe("t")
    expect(sql(`SELECT "userId" FROM "AuditLog" WHERE "entityId" = ${lit(draft.dealId)} AND "action" = 'ASSET_DEAL_SUBMITTED'`)).toBe(fx.officer)
    expect(sql(`SELECT "userId" FROM "AuditLog" WHERE "entityId" = ${lit(draft.dealId)} AND "action" = 'DEALER_SUBMISSION_ACCEPTED'`)).toBe(fx.officer)
    expect(await inTenant(fx, () => acceptDealerSubmission(staffOf(fx), draft.dealId))).toMatchObject({ kind: "not_draft" })
  })
})
