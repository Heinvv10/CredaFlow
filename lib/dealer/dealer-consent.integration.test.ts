/**
 * Real-Postgres proof of the dealer consent and document-request rows
 * (migration 20261019120100_dealer_portal). guardDealerConsentAttestation: the
 * document is the same deal's POPIA_CONSENT upload by that dealer, not
 * deleted; the subject is the deal's client or an active relationship person
 * of its entity, captured by the deal's dealer (a lender-added person's
 * consent is the lender's to record); the attesting user is the deal's
 * dealer's; only the staff
 * verification may be added, once; never deleted. guardDealerDocumentRequest:
 * fulfilled once by a document of the same deal and type; nothing else
 * changes; never deleted; the note is at most 500 characters.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-consent.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let deal: string
let otherDeal: string
let entity: string
let director: string
let consentDoc: string

function person(dealerId: string): string {
  const id = newId("cli")
  sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "createdByDealerId", "updatedAt")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(id)}, ${lit(syntheticSaIdNumber())}, 'TEST', 'Director', ${lit(`${id}@client.invalid`)}, '+27820000000',
      ${lit(dealerId)}, CURRENT_TIMESTAMP)`)
  return id
}
const relate = (clientId: string, active = true) => sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
  VALUES ('${newId("rel")}', ${lit(fx.tenantId)}, ${lit(entity)}, ${lit(clientId)}, 'DIRECTOR', ${active}, CURRENT_TIMESTAMP)`)
function document(dealId: string, over: { type?: string; by?: "dealer" | "staff"; uploader?: string } = {}): string {
  const id = newId("doc")
  sql(`INSERT INTO "EntityDocument" ("id", "tenantId", "entityId", "dealId", "docType", "fileName", "mimeType", "fileSize", "storagePath",
      "contentSha256", "uploadedByType", "uploadedById")
    SELECT ${lit(id)}, ${lit(fx.tenantId)}, d."entityId", d."id", '${over.type ?? "POPIA_CONSENT"}', 'consent.pdf', 'application/pdf', 1,
      '/nonexistent/consent.pdf', repeat('0', 64), '${over.by ?? "dealer"}', ${lit(over.uploader ?? (over.by === "staff" ? fx.officer : fx.salesUserA))}
    FROM "AssetFinanceDeal" d WHERE d."id" = ${lit(dealId)}`)
  return id
}
const attest = (over: { dealId?: string; clientId?: string; documentId?: string; dealerUserId?: string } = {}) =>
  `INSERT INTO "DealerConsentAttestation" ("id", "tenantId", "dealId", "clientId", "documentId", "dealerUserId", "statementVersion", "statementText")
   VALUES ('${newId("dca")}', ${lit(fx.tenantId)}, ${lit(over.dealId ?? deal)}, ${lit(over.clientId ?? director)}, ${lit(over.documentId ?? consentDoc)},
     ${lit(over.dealerUserId ?? fx.salesUserA)}, 'dealer-consent-v1', 'TEST statement')`
const request = (dealId: string, note = "Please upload the latest bank statement") => {
  const id = newId("ddr")
  return { id, insert: `INSERT INTO "DealerDocumentRequest" ("id", "tenantId", "dealId", "docType", "note", "requestedById")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(dealId)}, 'BANK_STATEMENT', ${lit(note)}, ${lit(fx.officer)})` }
}
const fulfil = (requestId: string, documentId: string) =>
  `UPDATE "DealerDocumentRequest" SET "fulfilledDocumentId" = ${lit(documentId)}, "fulfilledAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(requestId)}`

suite.sequential("dealer consent attestations and document requests (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    const captured = captureForDealer(fx, fx.dealerA)
    entity = captured.entityId
    director = person(fx.dealerA)
    relate(director)
    deal = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captured }).dealId
    otherDeal = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captureForDealer(fx, fx.dealerA) }).dealId
    consentDoc = document(deal)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  describe("consent attestation", () => {
    it("accepts the deal's dealer-uploaded POPIA consent for a relationship person", () => {
      sql(attest())
      expect(sql(`SELECT count(*) FROM "DealerConsentAttestation" WHERE "dealId" = ${lit(deal)}`)).toBe("1")
    })

    it("refuses a document that is not the dealer's POPIA consent upload on this deal", () => {
      const message = "A dealer consent attestation cites the deal's POPIA consent document the dealer uploaded"
      expectRejected(attest({ documentId: document(deal, { by: "staff" }) }), message)
      expectRejected(attest({ documentId: document(deal, { type: "BANK_STATEMENT" }) }), message)
      expectRejected(attest({ documentId: document(otherDeal) }), message)
      expectRejected(attest({ documentId: document(deal, { uploader: fx.userB }) }), message)
      const deleted = document(deal)
      sql(`UPDATE "EntityDocument" SET "deletedAt" = CURRENT_TIMESTAMP, "deletedById" = ${lit(fx.officer)} WHERE "id" = ${lit(deleted)}`)
      expectRejected(attest({ documentId: deleted }), message)
    })

    it("refuses a subject who is not on the deal", () => {
      const message = "The consent's subject is the deal's client or an active person of its entity"
      expectRejected(attest({ clientId: fx.director }), message)
      const former = person(fx.dealerA)
      relate(former, false)
      expectRejected(attest({ clientId: former }), message)
    })

    it("refuses a person the dealer did not capture: the lender records that person's consent itself", () => {
      const message = "A dealer attests consent only for a person that dealer captured"
      relate(fx.director)
      expectRejected(attest({ clientId: fx.director }), message)
      const otherDealers = person(fx.dealerB)
      // Verified, so the link itself is allowed (EntityRelationship_dealer_contact_link); the attestation is still refused.
      sql(`UPDATE "Client" SET "dealerContactVerifiedAt" = CURRENT_TIMESTAMP, "dealerContactVerifiedById" = ${lit(fx.officer)} WHERE "id" = ${lit(otherDealers)}`)
      relate(otherDealers)
      expectRejected(attest({ clientId: otherDealers }), message)
    })

    it("refuses a dealer user of another dealer", () => {
      expectRejected(attest({ dealerUserId: fx.userB }), "The attesting user belongs to the deal's dealer")
    })

    it("adds only the staff verification, once, and is never deleted", () => {
      const id = lit(sql(`SELECT "id" FROM "DealerConsentAttestation" WHERE "dealId" = ${lit(deal)}`))
      const verify = `UPDATE "DealerConsentAttestation" SET "verifiedById" = ${lit(fx.officer)}, "verifiedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
      expectRejected(`UPDATE "DealerConsentAttestation" SET "statementText" = 'changed' WHERE "id" = ${id}`, "Only the staff verification is added to a consent attestation, once")
      expectRejected(`UPDATE "DealerConsentAttestation" SET "verifiedById" = ${lit(fx.officer)} WHERE "id" = ${id}`, "DealerConsentAttestation_verification_complete")
      sql(verify)
      expectRejected(verify, "Only the staff verification is added to a consent attestation, once")
      expectRejected(`DELETE FROM "DealerConsentAttestation" WHERE "id" = ${id}`, "A dealer consent attestation is never deleted")
      expectRejected(`BEGIN; TRUNCATE "DealerConsentAttestation"; ROLLBACK;`, "A dealer consent attestation is never deleted")
    })
  })

  describe("document request", () => {
    it("keeps the note to 500 characters and is created unfulfilled on a dealer deal", () => {
      expectRejected(request(deal, "x".repeat(501)).insert, "DealerDocumentRequest_note_length")
      expectRejected(request(deal, " ").insert, "DealerDocumentRequest_note_length")
      const staff = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...captureForDealer(fx, null) }).dealId
      expectRejected(request(staff).insert, "A document request is made on a dealer deal, unfulfilled")
    })

    it("is fulfilled once, by a document of the same deal and type; nothing else changes; never deleted", () => {
      const { id, insert } = request(deal)
      sql(insert)
      const message = "A document request is fulfilled once, by a live document of its deal and type"
      expectRejected(fulfil(id, document(otherDeal, { type: "BANK_STATEMENT" })), message)
      expectRejected(fulfil(id, document(deal, { type: "AFS" })), message)
      const statement = document(deal, { type: "BANK_STATEMENT" })
      sql(fulfil(id, statement))
      expectRejected(fulfil(id, document(deal, { type: "BANK_STATEMENT" })), message)
      expectRejected(`UPDATE "DealerDocumentRequest" SET "note" = 'changed' WHERE "id" = ${lit(id)}`, message)
      expectRejected(`DELETE FROM "DealerDocumentRequest" WHERE "id" = ${lit(id)}`, "A document request is never deleted")
      expectRejected(`BEGIN; TRUNCATE "DealerDocumentRequest"; ROLLBACK;`, "A document request is never deleted")
    })
  })
})
