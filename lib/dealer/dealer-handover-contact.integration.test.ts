/**
 * Real-Postgres proof of two review-round-1 rules (migration
 * 20261019120300_dealer_portal_review_fixes):
 *
 *  - AssetFinanceDeal_dealer_handover: a dealer deal leaves DRAFT (other than
 *    to CANCELLED) only after the dealer handed it over (dealerSubmittedAt).
 *  - Client_dealer_contact_guard and the Client_dealer_contact_* CHECKs: the
 *    contact details a dealer typed are untrusted until staff verify them;
 *    until then no portal password is set. Verification is staff, once, and
 *    only on a dealer-captured client; verifyDealerContact is that staff
 *    action, for a person on the deal, audited.
 *  - AssetFinanceDeal_dealer_contacts_verified (migration
 *    20261019120400): no deal, dealer's or staff's, is BOOKED while a person
 *    on it a dealer captured has unverified contact details; booking's load
 *    step refuses first, with a reason.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-handover-contact.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { prisma } from "@/lib/prisma"
import { loadBookingDeal } from "@/lib/asset-finance/booking-load"
import { approve, book, captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"
import { inTenant, staffOf } from "./dealer-origination.integration-fixture"
import { verifyDealerContact } from "./contact-verification"
import { entityContactRecipients } from "@/lib/asset-finance/entity-contacts"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

function client(dealerId: string | null): string {
  const id = newId("cli")
  sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "createdByDealerId", "updatedAt")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(id)}, ${lit(syntheticSaIdNumber())}, 'TEST', 'Borrower', ${lit(`${id}@client.invalid`)}, '+27820000000',
      ${lit(dealerId)}, CURRENT_TIMESTAMP)`)
  return id
}
const setPassword = (clientId: string) => `UPDATE "Client" SET "portalPassword" = '$2a$12$synthetic' WHERE "id" = ${lit(clientId)}`
const verify = (clientId: string, by = fx.officer) =>
  `UPDATE "Client" SET "dealerContactVerifiedAt" = CURRENT_TIMESTAMP, "dealerContactVerifiedById" = ${lit(by)} WHERE "id" = ${lit(clientId)}`

suite.sequential("dealer hand-over and dealer-captured contact details (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  describe("hand-over", () => {
    it("refuses moving a dealer deal on from DRAFT before the dealer handed it over", () => {
      const { dealId } = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captureForDealer(fx, fx.dealerA) })
      expectRejected(`UPDATE "AssetFinanceDeal" SET "status" = 'SUBMITTED' WHERE "id" = ${lit(dealId)}`, "AssetFinanceDeal_dealer_handover")
      sql(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(dealId)}`)
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'SUBMITTED' WHERE "id" = ${lit(dealId)}`)
      expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)).toBe("SUBMITTED")
    })

    it("lets staff cancel an unsubmitted dealer draft, and leaves staff deals alone", () => {
      const { dealId } = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captureForDealer(fx, fx.dealerA) })
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelledById" = ${lit(fx.officer)},
        "cancelReason" = 'Synthetic: unsubmitted dealer draft' WHERE "id" = ${lit(dealId)}`)
      const staff = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...captureForDealer(fx, null) }).dealId
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'SUBMITTED' WHERE "id" = ${lit(staff)}`)
      expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(staff)}`)).toBe("SUBMITTED")
    })
  })

  describe("dealer-captured contact details", () => {
    it("refuses a portal password until staff verify the contact details, then allows it", () => {
      const captured = client(fx.dealerA)
      expectRejected(setPassword(captured), "staff verify the contact details a dealer captured")
      sql(verify(captured))
      sql(setPassword(captured))
      expect(sql(`SELECT "portalPassword" IS NOT NULL FROM "Client" WHERE "id" = ${lit(captured)}`)).toBe("t")
    })

    it("refuses a dealer-captured client inserted with a portal password or already verified", () => {
      const id = newId("cli")
      const insert = (extra: string, values: string) => `INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email",
          "phone", "createdByDealerId", "updatedAt"${extra})
        VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(id)}, ${lit(syntheticSaIdNumber())}, 'TEST', 'Borrower', ${lit(`${id}@client.invalid`)}, '+27820000000',
          ${lit(fx.dealerA)}, CURRENT_TIMESTAMP${values})`
      expectRejected(insert(`, "portalPassword"`, `, '$2a$12$synthetic'`), "staff verify the contact details a dealer captured")
      expectRejected(insert(`, "dealerContactVerifiedAt", "dealerContactVerifiedById"`, `, CURRENT_TIMESTAMP, ${lit(fx.officer)}`),
        "verified by staff after the dealer captured them")
    })

    it("verifies once, completely, and only a dealer-captured client", () => {
      const captured = client(fx.dealerA)
      expectRejected(`UPDATE "Client" SET "dealerContactVerifiedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(captured)}`, "Client_dealer_contact_verification_complete")
      sql(verify(captured))
      expectRejected(verify(captured, fx.adminA), "verified once")
      expectRejected(`UPDATE "Client" SET "dealerContactVerifiedAt" = NULL, "dealerContactVerifiedById" = NULL WHERE "id" = ${lit(captured)}`, "verified once")
      expectRejected(verify(client(null)), "Client_dealer_contact_verification_dealer_only")
    })

    it("is recorded by staff for a dealer-captured person on the deal, once, audited", async () => {
      const captured = captureForDealer(fx, fx.dealerA)
      const { dealId } = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captured })
      const relate = (clientId: string) => sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
        VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(captured.entityId)}, ${lit(clientId)}, 'DIRECTOR', true, CURRENT_TIMESTAMP)`)
      const director = client(fx.dealerA)
      relate(director)
      const lenderAdded = client(null)
      relate(lenderAdded)
      const verify = (clientId: string) => inTenant(fx, () => verifyDealerContact(staffOf(fx), dealId, clientId))
      expect(await verify(client(fx.dealerA))).toMatchObject({ status: 404 }) // not on the deal
      expect(await verify(lenderAdded)).toMatchObject({ status: 404 }) // the lender's own capture: nothing to verify
      expect(await verify(director)).toEqual({ kind: "verified" })
      expect(sql(`SELECT "dealerContactVerifiedById" FROM "Client" WHERE "id" = ${lit(director)}`)).toBe(fx.officer)
      expect(sql(`SELECT "userId", "newValue"->>'dealId' FROM "AuditLog" WHERE "entityId" = ${lit(director)} AND "action" = 'DEALER_CONTACT_VERIFIED'`))
        .toBe(`${fx.officer}|${dealId}`)
      expect(await verify(director)).toMatchObject({ status: 409 })
    })

    it("refuses to book a dealer deal until every dealer-captured person on it is verified", async () => {
      const captured = captureForDealer(fx, fx.dealerA)
      const { dealId } = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captured })
      const director = client(fx.dealerA)
      sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
        VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(captured.entityId)}, ${lit(director)}, 'DIRECTOR', true, CURRENT_TIMESTAMP)`)
      approve(fx, dealId)
      // book() writes the booking's history, then the CONTRACTED -> BOOKED move, which the database refuses.
      expect(() => book(fx, dealId)).toThrow(/contact details/)
      expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)).toBe("CONTRACTED")
      const loaded = await inTenant(fx, () => prisma.$transaction((tx) => loadBookingDeal(tx, fx.tenantId, dealId)))
      expect(loaded).toMatchObject({ kind: "refused", reason: "dealer_contact_unverified" })
      sql(verify(director))
      const loanId = sql(`SELECT l."id" FROM "Loan" l JOIN "AssetFinanceDeal" d ON d."applicationId" = l."applicationId" WHERE d."id" = ${lit(dealId)}`)
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'BOOKED', "loanId" = ${lit(loanId)} WHERE "id" = ${lit(dealId)}`)
      expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)).toBe("BOOKED")
    })

    it("gates a staff deal on a dealer-captured borrower the same way, and staff verify from that deal", async () => {
      const captured = captureForDealer(fx, fx.dealerA)
      // Linked while the business had no deal (EntityRelationship_dealer_contact_link refuses it after).
      const director = client(fx.dealerA)
      sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
        VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(captured.entityId)}, ${lit(director)}, 'DIRECTOR', true, CURRENT_TIMESTAMP)`)
      const { dealId } = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...captured })
      approve(fx, dealId)
      expect(() => book(fx, dealId)).toThrow(/contact details/)
      const loaded = await inTenant(fx, () => prisma.$transaction((tx) => loadBookingDeal(tx, fx.tenantId, dealId)))
      expect(loaded).toMatchObject({ kind: "refused", reason: "dealer_contact_unverified" })
      expect(await inTenant(fx, () => verifyDealerContact(staffOf(fx), dealId, director))).toEqual({ kind: "verified" })
      const loanId = sql(`SELECT l."id" FROM "Loan" l JOIN "AssetFinanceDeal" d ON d."applicationId" = l."applicationId" WHERE d."id" = ${lit(dealId)}`)
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'BOOKED', "loanId" = ${lit(loanId)} WHERE "id" = ${lit(dealId)}`)
      expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)).toBe("BOOKED")
    })

    it("sends an entity's servicing messages to no dealer-captured person until staff verify them", async () => {
      const captured = captureForDealer(fx, fx.dealerA)
      const relate = (clientId: string) => sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
        VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(captured.entityId)}, ${lit(clientId)}, 'DIRECTOR', true, CURRENT_TIMESTAMP)`)
      const dealers = client(fx.dealerA)
      const lenders = client(null)
      relate(dealers)
      relate(lenders)
      const recipients = () => inTenant(fx, async () => (await entityContactRecipients(prisma, fx.tenantId, captured.entityId)).map((r) => r.clientId).sort())
      expect(await recipients()).toEqual([lenders])
      sql(verify(dealers))
      expect(await recipients()).toEqual([dealers, lenders].sort())
    })

    it("refuses any Loan (a consumer loan included) for a client whose dealer-typed contacts are unverified", () => {
      const insertLoan = (clientId: string) => `INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "productId", "principal",
          "totalInterest", "initiationFee", "totalRepayable", "outstandingPrincipal", "startDate", "maturityDate", "interestRatePm", "interestModel", "updatedAt")
        VALUES (${lit(newId("loan"))}, ${lit(fx.tenantId)}, ${lit(newId("ref"))}, ${lit(newId("app"))}, ${lit(clientId)}, ${lit(fx.product)}, 100000,
          1000, 0, 101000, 100000, now(), now() + interval '1 year', 1.0, 'DAILY_ACCRUAL', now())`
      const rule = "A loan is made only after staff verify the contact details a dealer captured for its client"
      const captured = client(fx.dealerA)
      expectRejected(insertLoan(captured), rule)
      sql(verify(captured))
      // Past this rule the insert meets the loan's other guards; this one no longer refuses it.
      const after = (() => { try { sql(insertLoan(captured)); return "" } catch (error) { return String(error) } })()
      expect(after).not.toContain(rule)
    })

    it("leaves a staff-captured client's portal password alone", () => {
      const staff = client(null)
      sql(setPassword(staff))
      expect(sql(`SELECT "portalPassword" IS NOT NULL FROM "Client" WHERE "id" = ${lit(staff)}`)).toBe("t")
    })
  })
})
