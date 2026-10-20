/**
 * Review round 2 (PR #216): attacks on the "dealer-typed contact is untrusted
 * until staff verify it" fix (Client_dealer_contact_guard, TRUSTED_CONTACT_WHERE).
 *
 *  1. The portal forgot-password route issues no code to the email a dealer
 *     typed, and reset-password answers its own "no account" refusal (never a 500)
 *     even with a code obtained some other way (security round 2, S-R2-1).
 *  2. The guard itself: no portal password on an unverified dealer client by
 *     any write; the verification is set once and never cleared or changed;
 *     the provenance that makes the client "dealer-captured" cannot be cleared.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-contact-bypass.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, inTenant, personBody } from "./dealer-origination.integration-fixture"
import { captureDealerPerson } from "./capture"
import { POST as forgot } from "@/app/api/portal/forgot-password/route"
import { POST as reset } from "@/app/api/portal/reset-password/route"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true })) }))
vi.mock("@/lib/email/service", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }))
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

const post = (route: (r: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) =>
  route(new NextRequest(`https://${fx.host}${path}`, {
    method: "POST", headers: { host: fx.host, "content-type": "application/json", "x-forwarded-for": "198.51.100.9" },
    body: JSON.stringify({ turnstileToken: "x", ...body }),
  }))

async function dealerClient(email: string): Promise<string> {
  const captured = await inTenant(fx, () => captureDealerPerson(actorOf(fx, fx.salesUserA, fx.dealerA),
    personBody({ idNumber: syntheticSaIdNumber(), email, addressLine1: "1 Synthetic Road", city: "Johannesburg" }), null))
  if (captured.kind !== "created") throw new Error(JSON.stringify(captured))
  return captured.id
}

suite.sequential("dealer contact trust: bypass attempts (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(async () => {
    if (db && fx) sql(`DELETE FROM "ClientOtp" WHERE "email" LIKE '%-${t}@dealer.invalid'`)
    await cleanupDealerFixtureIfCreated(db, t)
  })

  it("forgot-password issues no code to the dealer-typed email, and reset-password refuses it cleanly", async () => {
    const inbox = `forgot-${t}@dealer.invalid`
    const clientId = await dealerClient(inbox)
    const asked = await post(forgot, "/api/portal/forgot-password", { email: inbox })
    const issued = sql(`SELECT count(*) FROM "ClientOtp" WHERE "email" = ${lit(inbox)}`)
    // The same generic answer as for an unknown email; no code reaches the untrusted contact.
    expect({ status: asked.status, issued }).toEqual({ status: 200, issued: "0" })
    // A code obtained some other way still resets nothing: the route's own "no account" answer, never a 500.
    sql(`INSERT INTO "ClientOtp" ("id", "email", "otp", "expiresAt") VALUES (${lit(`otp-${t}`)}, ${lit(inbox)}, '654321', now() + interval '10 minutes')`)
    const password = "TEST dealer-chosen passphrase 43"
    const refused = await post(reset, "/api/portal/reset-password", { email: inbox, otp: "654321", password, confirmPassword: password })
    expect(refused.status).toBe(404)
    expect(sql(`SELECT "portalPassword" IS NULL FROM "Client" WHERE "id" = ${lit(clientId)}`)).toBe("t")
  })

  it("the guard refuses a portal password, a cleared or changed verification, and clearing the provenance", async () => {
    const clientId = await dealerClient(`guard-${t}@dealer.invalid`)
    expectRejected(`UPDATE "Client" SET "portalPassword" = 'x' WHERE "id" = ${lit(clientId)}`, "No portal password until staff verify")
    expectRejected(`UPDATE "Client" SET "createdByDealerId" = NULL WHERE "id" = ${lit(clientId)}`, "createdByDealerId is set when the row is created")
    expectRejected(`UPDATE "Client" SET "dealerContactVerifiedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(clientId)}`, "Client_dealer_contact_verification_complete")
    sql(`UPDATE "Client" SET "dealerContactVerifiedAt" = CURRENT_TIMESTAMP, "dealerContactVerifiedById" = ${lit(fx.officer)} WHERE "id" = ${lit(clientId)}`)
    expectRejected(`UPDATE "Client" SET "dealerContactVerifiedAt" = NULL, "dealerContactVerifiedById" = NULL WHERE "id" = ${lit(clientId)}`, "verified once")
    expectRejected(`UPDATE "Client" SET "dealerContactVerifiedById" = ${lit(fx.adminB)} WHERE "id" = ${lit(clientId)}`, "verified once")
    sql(`UPDATE "Client" SET "portalPassword" = 'x' WHERE "id" = ${lit(clientId)}`)
    // After verification the email can still be changed (staff edit or the client's own profile): no re-verification.
    sql(`UPDATE "Client" SET "email" = ${lit(`changed-${t}@dealer.invalid`)} WHERE "id" = ${lit(clientId)}`)
    expect(sql(`SELECT "dealerContactVerifiedAt" IS NOT NULL FROM "Client" WHERE "id" = ${lit(clientId)}`)).toBe("t")
  })
})
