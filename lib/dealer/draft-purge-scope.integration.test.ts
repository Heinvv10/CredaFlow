/**
 * Real-Postgres proof of what the dealer draft purge erases and what it keeps
 * (lib/dealer/draft-purge.ts, guardDealerPurgedParty, dealerPurgeLinkedElsewhere;
 * SLICE5-FOLLOWUPS.md part D): every identifying column of a person and a
 * business; a business with another live deal and its people kept; two stale
 * drafts on one business not keeping each other; a lender-added person and a
 * person with a text-only link kept; documents of kept parties, documents a
 * kept business cites, and an earlier soft delete left as they were.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/draft-purge-scope.integration.test.ts
 */
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertDealerUser, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, assetBody, createdId, dealBody, dealerDraft, inTenant } from "./dealer-origination.integration-fixture"
import { captureDealerAsset } from "./capture"
import { createDealerDeal } from "./deals"
import { purgeDealerDeal } from "./draft-purge"
import { age, storedDocument } from "./draft-purge.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
const salesActor = () => actorOf(fx, insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA }), fx.dealerA)
const purge = (dealId: string) => inTenant(fx, () => purgeDealerDeal(fx.tenantId, dealId))
const rowJson = (table: string, id: string) => sql(`SELECT to_jsonb(r) FROM "${table}" r WHERE "id" = ${lit(id)}`)

/** A second draft of the same dealer on the same business (a second machine). */
async function secondDraftOn(entityId: string): Promise<string> {
  const actor = salesActor()
  return inTenant(fx, async () => {
    const assetId = createdId(await captureDealerAsset(actor, assetBody()))
    const deal = await createDealerDeal(actor, dealBody(fx, { entityId }, assetId))
    if (deal.kind !== "created") throw new Error(JSON.stringify(deal))
    return deal.dealId
  })
}

suite.sequential("dealer draft purge scope (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("overwrites every identifying column of the person and the business", async () => {
    const draft = await dealerDraft(fx, salesActor())
    await db!.client.update({
      where: { id: draft.directorId },
      data: {
        dateOfBirth: new Date("1980-01-01"), gender: "MALE", whatsapp: "+27820000002", suburb: "TEST", employmentStatus: "EMPLOYED",
        employerName: "TEST Employer", employerAddress: "TEST", employmentStartDate: new Date("2020-01-01"), monthlyIncome: 100, monthlyExpenses: 50,
        monthlyExpensesDeclaredAt: new Date(), grossMonthlyIncome: 120, incomeSourceType: "SALARY", salaryPaymentDay: 25, bankName: "TEST Bank",
        bankAccountNumber: "0000000001", bankBranchCode: "000001", accountType: "CHEQUE", nextOfKinName: "TEST Kin", nextOfKinPhone: "+27820000003",
        nextOfKinRelationship: "SIBLING", preferredLanguage: "af", creditScore: 600,
      },
    })
    // A portal password needs verified contacts (Client_dealer_contact_guard): set as history.
    sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "Client" SET "portalPassword" = 'x' WHERE "id" = ${lit(draft.directorId)}; COMMIT;`)
    await db!.businessEntity.update({
      where: { id: draft.entityId },
      data: { tradingName: "TEST Trading", mastersReference: "IT1/2026", vatNumber: "4000000001", annualTurnover: BigInt(1), totalAssetValue: BigInt(1),
        financialYearEnd: new Date("2026-02-28"), addressLine2: "TEST" },
    })
    age(draft.dealId, 91)
    expect(await purge(draft.dealId)).toMatchObject({ clientsErased: 1, entitiesErased: 1 })
    const person = JSON.parse(rowJson("Client", draft.directorId)) as Record<string, unknown>
    expect(person).toMatchObject({ firstName: "Erased", lastName: "Erased", phone: "", monthlyIncome: 0, monthlyExpenses: 0 })
    expect(person.idNumber).toMatch(new RegExp(`^erased-${draft.directorId}-[0-9a-f]{12}$`))
    expect(person.email).toMatch(new RegExp(`^erased-${draft.directorId}-[0-9a-f]{12}@erased\\.invalid$`))
    for (const column of ["dateOfBirth", "gender", "whatsapp", "addressLine1", "suburb", "city", "province", "postalCode", "employmentStatus",
      "employerName", "employerAddress", "employmentStartDate", "monthlyExpensesDeclaredAt", "grossMonthlyIncome", "incomeSourceType",
      "salaryPaymentDay", "bankName", "bankAccountNumber", "bankBranchCode", "accountType", "nextOfKinName", "nextOfKinPhone",
      "nextOfKinRelationship", "portalPassword", "preferredLanguage", "creditScore"]) {
      expect(person[column], column).toBeNull()
    }
    const business = JSON.parse(rowJson("BusinessEntity", draft.entityId)) as Record<string, unknown>
    expect(business).toMatchObject({ legalName: "Erased", financialsEvidenceIds: [] })
    expect(business.registrationNumber).toMatch(new RegExp(`^erased-${draft.entityId}-[0-9a-f]{12}$`))
    for (const column of ["tradingName", "mastersReference", "vatNumber", "annualTurnover", "totalAssetValue", "financialYearEnd",
      "addressLine1", "addressLine2", "city", "province", "postalCode"]) {
      expect(business[column], column).toBeNull()
    }
  })

  it("keeps a business with another live deal, and its director with it", async () => {
    const draft = await dealerDraft(fx, salesActor())
    await secondDraftOn(draft.entityId)
    age(draft.dealId, 91)
    const before = [rowJson("BusinessEntity", draft.entityId), rowJson("Client", draft.directorId)]
    expect(await purge(draft.dealId)).toMatchObject({ clientsErased: 0, clientsKept: 1, entitiesErased: 0, entitiesKept: 1 })
    expect([rowJson("BusinessEntity", draft.entityId), rowJson("Client", draft.directorId)]).toEqual(before)
  })

  it("does not let two abandoned drafts on one business keep each other", async () => {
    const draft = await dealerDraft(fx, salesActor())
    const other = await secondDraftOn(draft.entityId)
    age(draft.dealId, 91)
    age(other, 91)
    expect(await purge(draft.dealId)).toMatchObject({ clientsErased: 1, entitiesErased: 1 })
    expect(await purge(other)).toMatchObject({ clientsErased: 0, clientsKept: 0, entitiesErased: 0, entitiesKept: 0 })
  })

  it("keeps a business a person the lender added relates to, and that person", async () => {
    const draft = await dealerDraft(fx, salesActor())
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "updatedAt")
      VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(draft.entityId)}, ${lit(fx.director)}, 'DIRECTOR', CURRENT_TIMESTAMP); COMMIT;`)
    age(draft.dealId, 91)
    const before = [rowJson("Client", fx.director), rowJson("BusinessEntity", draft.entityId)]
    expect(await purge(draft.dealId)).toMatchObject({ clientsKept: 2, entitiesErased: 0, entitiesKept: 1 })
    expect([rowJson("Client", fx.director), rowJson("BusinessEntity", draft.entityId)]).toEqual(before)
  })

  it("keeps a person a CRM activity names (a link with no foreign key), and erases the business", async () => {
    const draft = await dealerDraft(fx, salesActor())
    sql(`INSERT INTO "CrmActivity" ("id", "tenantId", "type", "clientId", "subject", "createdById")
      VALUES (${lit(newId("act"))}, ${lit(fx.tenantId)}, 'CALL', ${lit(draft.directorId)}, 'TEST call', ${lit(fx.officer)})`)
    age(draft.dealId, 91)
    const before = rowJson("Client", draft.directorId)
    expect(await purge(draft.dealId)).toMatchObject({ clientsErased: 0, clientsKept: 1, entitiesErased: 1 })
    expect(rowJson("Client", draft.directorId)).toBe(before)
  })

  it("erases only documents whose party goes, and none a kept business cites; an earlier soft delete keeps its author", async () => {
    const draft = await dealerDraft(fx, salesActor())
    const consent = storedDocument(fx, draft.dealId)
    sql(`INSERT INTO "DealerConsentAttestation" ("id", "tenantId", "dealId", "clientId", "documentId", "dealerUserId", "statementVersion",
        "statementText", "signingMethod")
      VALUES (${lit(newId("dca"))}, ${lit(fx.tenantId)}, ${lit(draft.dealId)}, ${lit(draft.directorId)}, ${lit(consent.id)}, ${lit(fx.salesUserA)},
        'dealer-consent-v2', 'TEST statement', 'IN_PERSON')`)
    sql(`UPDATE "EntityDocument" SET "deletedAt" = CURRENT_TIMESTAMP, "deletedById" = ${lit(fx.officer)} WHERE "id" = ${lit(consent.id)}`)
    const loose = storedDocument(fx, draft.dealId, "BANK_STATEMENT")
    const cited = storedDocument(fx, draft.dealId, "AFS")
    sql(`UPDATE "BusinessEntity" SET "financialsEvidenceIds" = ARRAY[${lit(cited.id)}] WHERE "id" = ${lit(fx.evidenced)}`)
    age(draft.dealId, 91)
    expect(await purge(draft.dealId)).toMatchObject({ entitiesErased: 1, documentsErased: 2, documentsKept: 1, filesNotDeleted: 0 })
    expect(existsSync(consent.file) || existsSync(loose.file)).toBe(false)
    expect(existsSync(cited.file)).toBe(true)
    expect(sql(`SELECT "fileName", "deletedById" FROM "EntityDocument" WHERE "id" = ${lit(consent.id)}`)).toBe(`erased|${fx.officer}`)
    expect(sql(`SELECT count(*) FROM "EntityDocument" WHERE "id" = ${lit(loose.id)}`)).toBe("0")

    const kept = await dealerDraft(fx, salesActor())
    await secondDraftOn(kept.entityId)
    const own = storedDocument(fx, kept.dealId, "MANAGEMENT_ACCOUNTS")
    age(kept.dealId, 91)
    expect(await purge(kept.dealId)).toMatchObject({ entitiesKept: 1, documentsErased: 0, documentsKept: 1 })
    expect(existsSync(own.file)).toBe(true)
  })
})
