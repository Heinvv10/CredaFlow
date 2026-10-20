/**
 * What a dealer learns and controls through borrower capture (review
 * findings S1 and S3, PR #216).
 *
 *  1. Existence oracle: captureDealerPerson answers 409 "Already on the
 *     lender's book" for an SA ID number or email the lender already holds
 *     (any client, not the dealer's), and 201 otherwise. By design (spec
 *     deviation 9); each such refusal is audited, and captures are rate
 *     limited per dealer user.
 *  2. Contact takeover, closed: the email a dealer types for a captured person
 *     is untrusted until staff verify it. Until then POST /api/portal/register
 *     (real handler) sends no activation code and activates nothing; after the
 *     verification the borrower activates as any client does.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-borrower-identity.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, inTenant, personBody } from "./dealer-origination.integration-fixture"
import { ALREADY_ON_BOOK, captureDealerPerson } from "./capture"
import { POST } from "@/app/api/portal/register/route"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true })) }))
vi.mock("@/lib/email/service", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }))
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

suite.sequential("dealer borrower capture: oracle and contact takeover (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(async () => {
    if (db && fx) sql(`DELETE FROM "ClientOtp" WHERE "email" LIKE '%-${t}@dealer.invalid'`)
    await cleanupDealerFixtureIfCreated(db, t)
  })

  it("answers whether an ID number or email is on the lender's book, for a client the dealer never captured, and audits each such refusal", async () => {
    const dealerB = actorOf(fx, fx.userB, fx.dealerB, "DEALER_ADMIN")
    const staffDirectorId = sql(`SELECT "idNumber" FROM "Client" WHERE "id" = ${lit(fx.director)}`)
    const onBookById = await inTenant(fx, () => captureDealerPerson(dealerB, personBody({ idNumber: staffDirectorId }), null))
    const onBookByEmail = await inTenant(fx, () => captureDealerPerson(dealerB, personBody({ email: fx.directorEmail }), null))
    const unknown = await inTenant(fx, () => captureDealerPerson(dealerB, personBody(), null))
    expect(onBookById).toMatchObject({ kind: "refused", status: 409, error: ALREADY_ON_BOOK })
    expect(onBookByEmail).toMatchObject({ kind: "refused", status: 409, error: ALREADY_ON_BOOK })
    expect(unknown.kind).toBe("created")
    // One audit row per refusal, naming the dealer user and what was captured, never the values typed.
    const audited = sql(`SELECT count(*), min("newValue"->'actor'->>'dealerUserId'), min("newValue"->>'captured'), bool_and("newValue"::text NOT LIKE ${lit(`%${staffDirectorId}%`)})
      FROM "AuditLog" WHERE "tenantId" = ${lit(fx.tenantId)} AND "action" = 'DEALER_CAPTURE_REFUSED_ON_BOOK'`)
    expect(audited).toBe(`2|${fx.userB}|person|t`)
  })

  it("sends no activation code to the email a dealer typed, and activates nothing, until staff verify it", async () => {
    const dealerA = actorOf(fx, fx.salesUserA, fx.dealerA)
    const dealerInbox = `inbox-${t}@dealer.invalid`
    const borrowerId = syntheticSaIdNumber()
    const captured = await inTenant(fx, () => captureDealerPerson(dealerA, personBody({ idNumber: borrowerId, email: dealerInbox }), null))
    if (captured.kind !== "created") throw new Error(JSON.stringify(captured))

    const call = (body: Record<string, unknown>) => POST(new NextRequest(`https://${fx.host}/api/portal/register`, {
      method: "POST", headers: { host: fx.host, "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ email: dealerInbox, idNumber: borrowerId, turnstileToken: "x", ...body }),
    }))
    const otps = () => sql(`SELECT count(*) FROM "ClientOtp" WHERE "email" = ${lit(dealerInbox)}`)
    const password = "TEST dealer-chosen passphrase 42"

    // The same generic answer as for an unknown person, but no code is issued.
    expect((await call({})).status).toBe(200)
    expect(otps()).toBe("0")
    // A code issued some other way still activates nothing.
    sql(`INSERT INTO "ClientOtp" ("id", "email", "otp", "expiresAt") VALUES (${lit(`otp-${t}`)}, ${lit(dealerInbox)}, '123456', now() + interval '10 minutes')`)
    expect((await call({ otp: "123456", password, confirmPassword: password })).status).toBe(400)
    expect(sql(`SELECT "portalPassword" IS NULL FROM "Client" WHERE "id" = ${lit(captured.id)}`)).toBe("t")

    // Staff verify the contact details; the borrower then activates as any client does.
    sql(`UPDATE "Client" SET "dealerContactVerifiedAt" = CURRENT_TIMESTAMP, "dealerContactVerifiedById" = ${lit(fx.officer)} WHERE "id" = ${lit(captured.id)}`)
    expect((await call({})).status).toBe(200)
    const otp = sql(`SELECT "otp" FROM "ClientOtp" WHERE "email" = ${lit(dealerInbox)} AND NOT "used" AND "otp" <> '123456' ORDER BY "createdAt" DESC LIMIT 1`)
    expect(otp).toMatch(/^\d{6}$/)
    expect((await call({ otp, password, confirmPassword: password })).status).toBe(200)
    expect(sql(`SELECT "portalPassword" IS NOT NULL FROM "Client" WHERE "id" = ${lit(captured.id)}`)).toBe("t")
  })
})
