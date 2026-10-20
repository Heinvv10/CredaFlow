/**
 * Review round 4 (PR #216): attacks on EntityRelationship_dealer_contact_link
 * (migration 20261019120600) and the servicing recipient filter.
 *
 *  1. A link made while the business had only the dealer's own draft survives
 *     the hand-over (the trigger guards the link, not the later deal); the
 *     person is then excluded from entityContactRecipients until verified.
 *  2. Role changes and other column updates on an existing active link do not
 *     fire the trigger (UPDATE OF active, clientId, entityId only); the person
 *     stays filtered from servicing either way.
 *  3. Re-pointing an active unverified link to another business with a live
 *     deal is refused.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-entity-link-attacks.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { entityContactRecipients } from "@/lib/asset-finance/entity-contacts"
import { runWithTenant } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
const RULE = "contact details staff have not verified"

function client(dealerId: string | null): string {
  const id = newId("cli")
  sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "createdByDealerId", "updatedAt")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(id)}, ${lit(syntheticSaIdNumber())}, 'TEST', 'Person', ${lit(`${id}@client.invalid`)}, '+27820000000',
      ${lit(dealerId)}, CURRENT_TIMESTAMP)`)
  return id
}
function link(entityId: string, clientId: string, role = "SURETY"): string {
  const id = newId("rel")
  sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(entityId)}, ${lit(clientId)}, '${role}', true, CURRENT_TIMESTAMP)`)
  return id
}
const recipients = (entityId: string) =>
  runWithTenant(fx.tenantId, () => entityContactRecipients(prisma, fx.tenantId, entityId)).then((r) => r.map((c) => c.clientId))

suite.sequential("dealer-contact link guard: attacks (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("a link made during the dealer's draft survives the hand-over, a role change is not re-checked, and servicing still skips the person", async () => {
    const own = captureForDealer(fx, fx.dealerA)
    const { dealId } = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...own })
    const person = client(fx.dealerA)
    const rel = link(own.entityId, person, "SURETY")
    sql(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(dealId)}`)
    // Not a new link: promoting the surety to a portal-authority role is not re-checked by the trigger.
    sql(`UPDATE "EntityRelationship" SET "role" = 'DIRECTOR' WHERE "id" = ${lit(rel)}`)
    expect(sql(`SELECT "role"::text FROM "EntityRelationship" WHERE "id" = ${lit(rel)}`)).toBe("DIRECTOR")
    // ... but the servicing selector filters the unverified person out.
    expect(await recipients(own.entityId)).not.toContain(person)
    sql(`UPDATE "Client" SET "dealerContactVerifiedAt" = CURRENT_TIMESTAMP, "dealerContactVerifiedById" = ${lit(fx.officer)} WHERE "id" = ${lit(person)}`)
    expect(await recipients(own.entityId)).toContain(person)
  })

  it("refuses re-pointing an active unverified link at a business with a live deal", () => {
    const quiet = captureForDealer(fx, fx.dealerA)
    const busy = captureForDealer(fx, fx.dealerA)
    dealerDeal(fx, { dealerId: null, dealerUserId: null, ...busy })
    const rel = link(quiet.entityId, client(fx.dealerA), "DIRECTOR")
    expectRejected(`UPDATE "EntityRelationship" SET "entityId" = ${lit(busy.entityId)} WHERE "id" = ${lit(rel)}`, RULE)
  })
})
