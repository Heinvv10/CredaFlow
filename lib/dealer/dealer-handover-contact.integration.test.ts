/**
 * Real-Postgres proof of two review-round-1 rules (migration
 * 20261019120300_dealer_portal_review_fixes):
 *
 *  - AssetFinanceDeal_dealer_handover: a dealer deal leaves DRAFT (other than
 *    to CANCELLED) only after the dealer handed it over (dealerSubmittedAt).
 *  - Client_dealer_contact_guard and the Client_dealer_contact_* CHECKs: the
 *    contact details a dealer typed are untrusted until staff verify them;
 *    until then no portal password is set. Verification is staff, once, and
 *    only on a dealer-captured client.
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
import { captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"

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

    it("leaves a staff-captured client's portal password alone", () => {
      const staff = client(null)
      sql(setPassword(staff))
      expect(sql(`SELECT "portalPassword" IS NOT NULL FROM "Client" WHERE "id" = ${lit(staff)}`)).toBe("t")
    })
  })
})
