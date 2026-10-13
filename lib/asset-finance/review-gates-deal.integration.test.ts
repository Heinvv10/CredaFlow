/**
 * Real-Postgres proof of the deal-side database rules of the review round
 * (migrations 20261013114000..114200), one probe per rule, each in a
 * rolled-back transaction (./review-gates.integration-fixture.ts): the deal
 * status table, the signed-terms CHECKs and guard, the BOOKED freeze, the
 * entity-document binding, the snapshot-based contract gate, the DealSigner
 * CHECKs and wet-ink binding, the surety/signatory freeze, the asset identity
 * freeze and the release guard. Deal A is CONTRACTED (every signer
 * satisfied), deal B BOOKED.
 *
 *   RUN_ASSET_FINANCE_REVIEW_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/review-gates-deal.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dealFixtureTenantId } from "./deal.integration-fixture"
import { cleanupBookingFixture, type SessionUser } from "./payout-booking.integration-fixture"
import { acceptedSql, createReviewGatesFixture, refusedSql, unsignAll, type ReviewGatesFixture } from "./review-gates.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_REVIEW_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: ReviewGatesFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_REVIEW_IT=1 is required")
  return db
}
const deal = (id: () => string, set: string) => `UPDATE "AssetFinanceDeal" SET ${set} WHERE "id" = '${id()}'`
const A = () => fx.dealId
const B = () => fx.dealB
const cancelA = () => deal(A, `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = '${fx.adminA}', "cancelReason" = 'Synthetic cancellation'`)
const signer = (set: string, where: string) => `UPDATE "DealSigner" SET ${set} WHERE "dealId" = '${A()}' AND ${where}`
const copyDealA = (status: string, snapshot: boolean) => `INSERT INTO "AssetFinanceDeal" ("id", "tenantId", "applicationId", "entityId", "assetId",
  "supplierId", "weights", "structurePreset", "firstDueDate", "rateBasis", "rateMargin", "status", "createdById", "updatedAt",
  "plannedStartDate", "signedBaseInstalmentCents", "signedResultingRate", "signedTotalInterestCents", "signedArrearsMarginRate",
  "signedCollectionFeeCents", "preparedSigners")
  SELECT 'copy_${t}', "tenantId", 'app_copy_${t}', "entityId", "assetId", "supplierId", "weights", "structurePreset", "firstDueDate",
    "rateBasis", "rateMargin", '${status}', "createdById", now(),
    ${snapshot ? `"plannedStartDate", "signedBaseInstalmentCents", "signedResultingRate", "signedTotalInterestCents",
    "signedArrearsMarginRate", "signedCollectionFeeCents", "preparedSigners"` : "NULL, NULL, NULL, NULL, NULL, NULL, NULL"}
  FROM "AssetFinanceDeal" WHERE "id" = '${A()}'`

suite.sequential("review gates: deals, signing, people and assets (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createReviewGatesFixture(database(), t, (user) => { session.current = user && { user } })
  }, 240_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupBookingFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("signed terms CHECKs: whole, start before the first instalment, in range; a cancellation is complete", () => {
    expect(refusedSql("", deal(A, `"plannedStartDate" = NULL`), { triggers: false })).toContain("AssetFinanceDeal_signed_terms_complete")
    expect(refusedSql("", deal(A, `"plannedStartDate" = "firstDueDate"`), { triggers: false })).toContain("AssetFinanceDeal_planned_start_before_first_due")
    expect(refusedSql("", deal(A, `"signedCollectionFeeCents" = -1`), { triggers: false })).toContain("AssetFinanceDeal_signed_terms_range")
    expect(refusedSql("", deal(A, `"status" = 'CANCELLED'`), { triggers: false })).toContain("AssetFinanceDeal_cancellation_shape")
  })

  it.each([
    ["CONTRACTED", "APPROVED", ""],
    ["DECLINED", "SUBMITTED", `"status" = 'DECLINED'`],
    ["DRAFT", "APPROVED", `"status" = 'DRAFT'`],
    ["APPROVED", "REFERRED", `"status" = 'APPROVED'`],
  ])("the status table refuses %s → %s", (from, to, setup) => {
    expect(refusedSql(setup ? deal(A, setup) : "", deal(A, `"status" = '${to}'`))).toContain(`An asset deal cannot move from ${from} to ${to}`)
  })

  it("a CANCELLED deal is terminal; a deal is created DRAFT and without contract terms", () => {
    expect(refusedSql(cancelA(), deal(A, `"status" = 'DRAFT'`))).toContain("An asset deal cannot move from CANCELLED to DRAFT")
    expect(refusedSql("", copyDealA("SUBMITTED", false))).toContain("An asset deal is created DRAFT")
    expect(refusedSql("", copyDealA("DRAFT", true))).toContain("A deal is created without contract terms")
  })

  it.each([[`"decisionReasons" = ARRAY['edited']`], [`"depositCents" = "depositCents" + 1`], [`"rateMargin" = 0.02`]])(
    "a BOOKED deal is immutable: %s",
    (set) => {
      expect(refusedSql("", deal(B, set))).toContain("A booked deal is immutable")
    },
  )

  it.each([
    [`"storagePath" = '/elsewhere.pdf'`], [`"contentSha256" = repeat('1', 64)`], [`"uploadedById" = 'someone-else'`],
    [`"uploadedByType" = 'client'`], [`"dealId" = NULL`], [`"entityId" = 'other-entity'`],
  ])("an entity document's binding is fixed: %s", (set) => {
    const doc = `UPDATE "EntityDocument" SET ${set} WHERE "id" = (SELECT "id" FROM "EntityDocument" WHERE "dealId" = '${A()}' AND "docType" = 'SUPPLIER_INVOICE' LIMIT 1)`
    expect(refusedSql("", doc)).toContain("An entity document's bytes, entity, deal and uploader are fixed")
  })

  it("an entity document is still verified", () => {
    acceptedSql("", `UPDATE "EntityDocument" SET "verifiedAt" = now(), "verifiedById" = '${fx.adminB}' WHERE "dealId" = '${A()}'`)
  })

  it("contract terms change only while APPROVED, before any signature, with the signer set the entity requires", () => {
    expect(refusedSql("", deal(A, `"signedCollectionFeeCents" = 1`))).toContain("A deal's contract terms are prepared only while it is APPROVED")
    expect(refusedSql(deal(A, `"status" = 'APPROVED'`), deal(A, `"signedCollectionFeeCents" = 1`))).toContain("Signing has started")
    const reopened = `${deal(A, `"status" = 'APPROVED'`)}; ${unsignAll(A())}`
    for (const set of [`'[]'::jsonb`, `"preparedSigners" || "preparedSigners"`, `'{}'::jsonb`]) {
      expect(refusedSql(reopened, deal(A, `"preparedSigners" = ${set}`))).toContain("The prepared signer set must be the signatures the entity requires now")
    }
    acceptedSql(reopened, deal(A, `"signedCollectionFeeCents" = 7, "preparedSigners" =
      (SELECT jsonb_agg(e ORDER BY e->>'document' DESC, e->>'clientId') FROM jsonb_array_elements("preparedSigners") e)`))
  })

  describe("the contract gate counts against the prepared signer set", () => {
    const approved = () => deal(A, `"status" = 'APPROVED'`)
    const contract = () => deal(A, `"status" = 'CONTRACTED'`)

    it("every prepared signer satisfied → contracted, even with a surety added since preparation", () => {
      acceptedSql(approved(), contract())
      acceptedSql(`${approved()};
        INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
          VALUES ('late_${t}', '${fx.tenantId}', 'CLI-LATE-${t}', 'ID-LATE-${t}', 'TEST', 'Late', 'late-${t}@client.invalid', '+27820000000', now());
        INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "updatedAt")
          VALUES ('rel_late_${t}', '${fx.tenantId}', '${fx.evidenced}', 'late_${t}', 'SURETY', now())`, contract())
    })

    it.each([
      ["only from APPROVED", () => deal(A, `"status" = 'REFERRED'`), "An asset deal is contracted only from APPROVED"],
      ["documents prepared", () => `${approved()}; ${deal(A, `"plannedStartDate" = NULL, "signedBaseInstalmentCents" = NULL, "signedResultingRate" = NULL,
        "signedTotalInterestCents" = NULL, "signedArrearsMarginRate" = NULL, "signedCollectionFeeCents" = NULL, "preparedSigners" = NULL`)}`,
        "A deal is contracted only once its documents are prepared"],
      ["somebody with authority", () => `${approved()}; ${deal(A, `"preparedSigners" =
        (SELECT jsonb_agg(e) FROM jsonb_array_elements("preparedSigners") e WHERE e->>'document' = 'SURETYSHIP')`)}`,
        "The entity has nobody with authority to sign"],
      ["an AGREEMENT signer row", () => `${approved()}; DELETE FROM "DealSigner" WHERE "dealId" = '${A()}' AND "document" = 'AGREEMENT'`,
        "A deal is contracted only with an AGREEMENT signer"],
      ["agreement and resolution rows", () => `${approved()}; DELETE FROM "DealSigner" WHERE "dealId" = '${A()}' AND "document" = 'RESOLUTION'`,
        "Every authorised signatory signs the agreement and the resolution"],
      ["a suretyship row per prepared surety", () => `${approved()}; DELETE FROM "DealSigner" WHERE "dealId" = '${A()}' AND "clientId" = '${fx.suretyB}'`,
        "Every surety prepared for the deal signs a suretyship"],
      ["every row satisfied", () => `${approved()}; ${unsignAll(A())}`, "Every deal signer must have e-signed or have a confirmed wet-ink scan"],
    ])("refuses without %s", (_label, setup, message) => {
      expect(refusedSql(setup(), contract())).toContain(message)
    })
  })

  it("DealSigner CHECKs and the wet-ink binding", () => {
    expect(refusedSql("", signer(`"documentSha256" = 'x'`, `"document" = 'AGREEMENT'`), { triggers: false })).toContain("DealSigner_document_bound")
    expect(refusedSql("", signer(`"signatureSha256" = repeat('f', 64)`, `"document" = 'AGREEMENT'`), { triggers: false }))
      .toContain("DealSigner_method_evidence")
    const open = `${deal(A, `"status" = 'APPROVED'`)}; ${signer(`"confirmedById" = NULL, "confirmedAt" = NULL`, `"clientId" = '${fx.suretyA}'`)}`
    expect(refusedSql(open, signer(`"scanUploadedById" = '${fx.adminA}'`, `"clientId" = '${fx.suretyA}'`)))
      .toContain("A wet-ink scan is this deal's signed document of the same kind, uploaded by the recorded user")
  })

  it("a prepared surety or signatory stays while the deal is open; once it is cancelled they may go", () => {
    const surety = `"EntityRelationship" WHERE "entityId" = '${fx.evidenced}' AND "clientId" = '${fx.suretyA}' AND "role" = 'SURETY'`
    const director = `"EntityRelationship" WHERE "entityId" = '${fx.evidenced}' AND "clientId" = '${fx.director}' AND "role" = 'DIRECTOR'`
    for (const attempt of [`UPDATE ${surety.replace(" WHERE", ` SET "active" = false WHERE`)}`, `DELETE FROM ${surety}`,
      `UPDATE ${director.replace(" WHERE", ` SET "role" = 'MEMBER' WHERE`)}`]) {
      expect(refusedSql("", attempt)).toContain("The entity has an approved deal: its sureties and signatories are fixed")
    }
    acceptedSql(cancelA(), `UPDATE ${surety.replace(" WHERE", ` SET "active" = false WHERE`)}`)
  })

  it.each([
    [`"make" = 'OTHER'`], [`"model" = 'OTHER'`], [`"year" = 2020`], [`"serialNumber" = 'OTHERSERIAL'`], [`"vin" = 'OTHERVIN'`],
    [`"engineNumber" = 'OTHERENGINE'`], [`"registrationNumber" = 'OTHER1GP'`], [`"assetClass" = 'TLB'`],
    [`"cashPriceExclVatCents" = 100, "vatCents" = 15`],
  ])("an asset on an approved deal keeps its identity and price: %s", (set) => {
    const update = `UPDATE "FinancedAsset" SET ${set} WHERE "id" = '${fx.assetA}'`
    expect(refusedSql("", update)).toContain("The asset is on an approved deal: its identity and price are fixed")
    acceptedSql(cancelA(), update)
  })

  it.each([
    [`"insurer" = 'OTHER'`, "insurance"], [`"policyNumber" = 'OTHER'`, "insurance"], [`"lenderNotedConfirmed" = false`, "insurance"],
    [`"trackerId" = 'OTHER'`, "tracker"], [`"natisTitleholder" = 'OTHER'`, "eNaTIS titleholder"],
  ])("an attested asset fact is fixed: %s", (set, what) => {
    expect(refusedSql("", `UPDATE "FinancedAsset" SET ${set} WHERE "id" = '${fx.assetA}'`)).toContain(`The asset's ${what} is attested on a payout checklist`)
  })

  it("an asset is released only when no open deal and no open loan finance it", () => {
    const release = (asset: string) => `UPDATE "FinancedAsset" SET "releasedAt" = now() WHERE "id" = '${asset}'`
    const message = "An asset is released only when no open deal or active loan finances it"
    expect(refusedSql("", release(fx.assetA))).toContain(message)
    expect(refusedSql("", release(fx.assetB))).toContain(message)
    const cancelB = deal(B, `"status" = 'CANCELLED', "loanId" = NULL, "cancelledAt" = now(), "cancelledById" = '${fx.adminA}', "cancelReason" = 'Synthetic cancellation'`)
    expect(refusedSql(cancelB, release(fx.assetB))).toContain(message)
    // Every loan not COMPLETED, WRITTEN_OFF or CANCELLED still finances the asset, not just an ACTIVE one.
    for (const status of ["DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"]) {
      expect(refusedSql(`${cancelB}; UPDATE "Loan" SET "status" = '${status}' WHERE "id" = '${fx.loanB}'`, release(fx.assetB))).toContain(message)
    }
    for (const status of ["WRITTEN_OFF", "CANCELLED"]) {
      acceptedSql(`${cancelB}; UPDATE "Loan" SET "status" = '${status}' WHERE "id" = '${fx.loanB}'`, release(fx.assetB))
    }
    acceptedSql(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = '${fx.loanB}'`, release(fx.assetB))
    acceptedSql(cancelA(), release(fx.assetA))
  })
})
