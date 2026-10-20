/**
 * Real-Postgres proof of the dealer bank account rules, copies of the
 * supplier ones (migration 20261019120100_dealer_portal, guardDealerBankAccount
 * and its CHECKs): born PENDING; decided by a second user
 * (DealerBankAccount_four_eyes) with the verification recorded
 * (_approval_evidence) and the decision complete (_decision_complete); the
 * details never change; a decided row is frozen except APPROVED → SUPERSEDED;
 * one APPROVED account per dealer; never deleted.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-bank-accounts.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import {
  cleanupDealerFixtureIfCreated, createDealerFixture, decideDealerAccount, lit, newId, requestDealerAccount, type DealerFixture,
} from "./dealer.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

const statusOf = (id: string) => sql(`SELECT "status" FROM "DealerBankAccount" WHERE "id" = ${lit(id)}`)

suite.sequential("dealer bank accounts: four eyes and evidence (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("is created PENDING", () => {
    expectRejected(`INSERT INTO "DealerBankAccount" ("id", "tenantId", "dealerId", "bankName", "branchCode", "accountNumber", "accountHolder",
        "requestedById", "status", "decidedById", "decidedAt", "avsResult")
      VALUES ('${newId("dba")}', ${lit(fx.tenantId)}, ${lit(fx.dealerA)}, 'TEST Bank', '000001', '0000000009', 'TEST', ${lit(fx.officer)},
        'APPROVED', ${lit(fx.adminB)}, CURRENT_TIMESTAMP, '{}')`, "A dealer bank account is created PENDING")
  })

  it("refuses a self-decision", () => {
    const id = requestDealerAccount(fx, fx.dealerA, fx.officer)
    expectRejected(decideDealerAccount(id, fx.officer), "DealerBankAccount_four_eyes")
    expectRejected(decideDealerAccount(id, fx.officer, "REJECTED"), "DealerBankAccount_four_eyes")
    expect(statusOf(id)).toBe("PENDING")
  })

  it("refuses an approval without its verification, and an incomplete decision", () => {
    const id = requestDealerAccount(fx, fx.dealerA, fx.officer)
    expectRejected(`UPDATE "DealerBankAccount" SET "status" = 'APPROVED', "decidedById" = ${lit(fx.adminB)}, "decidedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${lit(id)}`, "DealerBankAccount_approval_evidence")
    expectRejected(`UPDATE "DealerBankAccount" SET "status" = 'APPROVED', "avsResult" = '{}' WHERE "id" = ${lit(id)}`, "DealerBankAccount_decision_complete")
    expectRejected(`UPDATE "DealerBankAccount" SET "status" = 'SUPERSEDED' WHERE "id" = ${lit(id)}`, "A PENDING dealer bank account is approved or rejected")
  })

  it("never changes its details: a different account is a new request", () => {
    const id = requestDealerAccount(fx, fx.dealerA, fx.officer)
    expectRejected(`UPDATE "DealerBankAccount" SET "accountNumber" = '9999999999' WHERE "id" = ${lit(id)}`, "A dealer bank account's details are fixed")
    expectRejected(`UPDATE "DealerBankAccount" SET "dealerId" = ${lit(fx.dealerB)} WHERE "id" = ${lit(id)}`, "A dealer bank account's details are fixed")
    expectRejected(`UPDATE "DealerBankAccount" SET "requestedById" = ${lit(fx.adminA)} WHERE "id" = ${lit(id)}`, "A dealer bank account's details are fixed")
    sql(decideDealerAccount(id, fx.adminB))
    expectRejected(`UPDATE "DealerBankAccount" SET "branchCode" = '999999' WHERE "id" = ${lit(id)}`, "A dealer bank account's details are fixed")
  })

  it("has one APPROVED account per dealer; a decided row is frozen except APPROVED → SUPERSEDED", () => {
    const current = sql(`SELECT "id" FROM "DealerBankAccount" WHERE "dealerId" = ${lit(fx.dealerA)} AND "status" = 'APPROVED'`)
    const next = requestDealerAccount(fx, fx.dealerA, fx.officer, "0000000010")
    expectRejected(decideDealerAccount(next, fx.adminB), "DealerBankAccount_one_approved_per_dealer")
    expectRejected(`UPDATE "DealerBankAccount" SET "status" = 'REJECTED' WHERE "id" = ${lit(current)}`, "A decided dealer bank account is frozen")
    expectRejected(`UPDATE "DealerBankAccount" SET "decidedById" = ${lit(fx.adminA)} WHERE "id" = ${lit(current)}`, "A decided dealer bank account is frozen")
    sql(`UPDATE "DealerBankAccount" SET "status" = 'SUPERSEDED' WHERE "id" = ${lit(current)}`)
    sql(decideDealerAccount(next, fx.adminB))
    expect([statusOf(current), statusOf(next)]).toEqual(["SUPERSEDED", "APPROVED"])
    expectRejected(`UPDATE "DealerBankAccount" SET "status" = 'APPROVED' WHERE "id" = ${lit(current)}`, "A decided dealer bank account is frozen")
    // the other dealer's approved account is independent
    const theirs = requestDealerAccount(fx, fx.dealerB, fx.officer)
    sql(decideDealerAccount(theirs, fx.adminB))
  })

  it("is never deleted", () => {
    const id = requestDealerAccount(fx, fx.dealerA, fx.officer, "0000000011")
    expectRejected(`DELETE FROM "DealerBankAccount" WHERE "id" = ${lit(id)}`, "A dealer bank account is never deleted")
    expectRejected(`BEGIN; TRUNCATE "DealerBankAccount" CASCADE; ROLLBACK;`, "A dealer bank account is never deleted")
  })
})
