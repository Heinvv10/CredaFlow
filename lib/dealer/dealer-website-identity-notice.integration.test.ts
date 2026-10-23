/**
 * Review round 6 (PR #216): the public website apply form's identity-conflict
 * notice goes to the matched client's email ON FILE. For a person a dealer
 * captured whose contact details staff have not verified, that address is the
 * one the dealer typed, so no notice is sent to it (the audit row is kept):
 * a borrower applying to the lender directly never makes the lender email the
 * dealer. Positive control: once staff verify the person's contact details,
 * the notice goes to the address on file again.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-website-identity-notice.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, inTenant, personBody } from "./dealer-origination.integration-fixture"
import { captureDealerPerson } from "./capture"

const m = vi.hoisted(() => ({ tenant: null as null | Record<string, unknown>, sendEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tenant")>()
  return { ...original, getTenantFromRequest: vi.fn(async () => m.tenant) }
})
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true })) }))
vi.mock("@/lib/referral-agents/referrals", () => ({ resolveReferralCode: vi.fn(async () => null), recordReferralEvent: vi.fn(async () => undefined) }))
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }))
vi.mock("@/lib/messaging/agent-message-template", () => ({ getOrCreateAgentMessageTemplate: vi.fn() }))
vi.mock("@/lib/email/service", () => ({ sendEmail: m.sendEmail }))

import { POST as apply } from "@/app/api/website/apply/route"

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
// The notice builds a portal link; without this it fails before sending.
process.env.NEXT_PUBLIC_PORTAL_URL ||= "https://portal.lender.invalid"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

suite.sequential("website identity-conflict notice to a dealer-typed email (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    m.tenant = await db.tenant.findUniqueOrThrow({ where: { id: fx.tenantId }, select: { id: true, slug: true, name: true, domain: true, status: true } })
    await db.loanProduct.create({ data: {
      tenantId: fx.tenantId, code: `PL-${t}`, name: "TEST personal loan", productType: "PERSONAL",
      minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL",
      initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: 6_900,
    } })
  }, 60_000)

  afterAll(async () => {
    if (db && fx) {
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM "NotificationThrottle" WHERE "tenantId" = ${lit(fx.tenantId)};
        DELETE FROM "CrmActivity" WHERE "tenantId" = ${lit(fx.tenantId)};
        DELETE FROM "ContactIdentity" WHERE "tenantId" = ${lit(fx.tenantId)};
        DELETE FROM "Contact" WHERE "tenantId" = ${lit(fx.tenantId)};
        DELETE FROM "ConsentRecord" WHERE "tenantId" = ${lit(fx.tenantId)};
        DELETE FROM "Lead" WHERE "tenantId" = ${lit(fx.tenantId)};
        DELETE FROM "LoanProduct" WHERE "tenantId" = ${lit(fx.tenantId)} AND "productType" = 'PERSONAL';
        COMMIT;`)
    }
    await cleanupDealerFixtureIfCreated(db, t)
  })

  async function applyWithOwnEmail(borrowerIdNumber: string, label: string): Promise<{ to: string[]; audit: Record<string, unknown> }> {
    m.sendEmail.mockClear()
    const borrowerEmail = `borrower-${label}-${t}@client.invalid`
    const res = await apply(new NextRequest(`https://${fx.host}/api/website/apply`, {
      method: "POST", headers: { host: fx.host, "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "TEST", lastName: "Borrower", email: borrowerEmail, phone: "+27820000011", idNumber: borrowerIdNumber,
        employmentStatus: "EMPLOYED", employerName: "Synthetic Employer", monthlyIncome: 15_000, monthlyExpenses: 5_000,
        productType: "PERSONAL", amount: 5_000, termDays: 30, purpose: "Synthetic", popiaConsent: true, turnstileToken: "x",
      }),
    }))
    expect(res.status).toBeLessThan(500)
    const to = (m.sendEmail.mock.calls as unknown as Array<[{ to: string; category: string }]>)
      .map(([arg]) => arg).filter((arg) => arg.category === "portal-identity-notice").map((n) => n.to)
    const audit = await db!.auditLog.findFirstOrThrow({
      where: { tenantId: fx.tenantId, action: "APPLICATION_SUBMISSION_BLOCKED", userEmail: borrowerEmail },
      select: { newValue: true },
    })
    return { to, audit: audit.newValue as Record<string, unknown> }
  }

  async function capturedPerson(dealerInbox: string): Promise<{ clientId: string; idNumber: string }> {
    const idNumber = syntheticSaIdNumber()
    const captured = await inTenant(fx, () => captureDealerPerson(actorOf(fx, fx.salesUserA, fx.dealerA),
      personBody({ idNumber, email: dealerInbox, addressLine1: "1 Synthetic Road", city: "Johannesburg" }), null))
    expect(captured.kind).toBe("created")
    const clientId = (captured as { id: string }).id
    expect(sql(`SELECT "dealerContactVerifiedAt" IS NULL FROM "Client" WHERE "id" = ${lit(clientId)}`)).toBe("t")
    return { clientId, idNumber }
  }

  it("sends no identity notice to the dealer-typed address when the borrower applies with their own email", async () => {
    const dealerInbox = `inbox-${t}@dealer.invalid`
    const person = await capturedPerson(dealerInbox)
    const { to, audit } = await applyWithOwnEmail(person.idNumber, "unverified")
    expect(to).toEqual([])
    expect(audit).toMatchObject({ noticeRecipientClientId: person.clientId, noticeSent: false, noticeWithheld: "dealer_contact_unverified" })
  })

  it("sends the notice to the address on file once staff verified the contact details (positive control)", async () => {
    const onFile = `verified-${t}@client.invalid`
    const person = await capturedPerson(onFile)
    sql(`UPDATE "Client" SET "dealerContactVerifiedAt" = now(), "dealerContactVerifiedById" = ${lit(fx.officer)} WHERE "id" = ${lit(person.clientId)}`)
    const { to, audit } = await applyWithOwnEmail(person.idNumber, "verified")
    expect(to).toEqual([onFile])
    expect(audit).toMatchObject({ noticeRecipientClientId: person.clientId, noticeSent: true })
    expect(audit).not.toHaveProperty("noticeWithheld")
  })
})
