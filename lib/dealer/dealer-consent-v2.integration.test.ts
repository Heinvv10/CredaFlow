/**
 * Real-Postgres proof of dealer consent v2 (migration 20261022100000_dealer_followups,
 * SLICE5-FOLLOWUPS.md part D): a new attestation says how the form was signed
 * (CHECK DealerConsentAttestation_signing_method: REMOTE with the identity
 * check, IN_PERSON without), never uses dealer-consent-v1
 * (DealerConsentAttestation_current_version), and a v1 row attested before the
 * change stays exactly as it was (guardDealerConsentAttestation).
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-consent-v2.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, dealerDraft, inTenant, type DealerDraft } from "./dealer-origination.integration-fixture"
import { attestDealerConsent, DEALER_CONSENT_STATEMENT, dealerConsentSnapshot } from "./consent"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let draft: DealerDraft

function consentDocument(dealId: string): string {
  const id = newId("doc")
  sql(`INSERT INTO "EntityDocument" ("id", "tenantId", "entityId", "dealId", "docType", "fileName", "mimeType", "fileSize", "storagePath",
      "contentSha256", "uploadedByType", "uploadedById")
    SELECT ${lit(id)}, ${lit(fx.tenantId)}, d."entityId", d."id", 'POPIA_CONSENT', 'consent.pdf', 'application/pdf', 1,
      '/nonexistent/consent.pdf', repeat('0', 64), 'dealer', ${lit(fx.salesUserA)}
    FROM "AssetFinanceDeal" d WHERE d."id" = ${lit(dealId)}`)
  return id
}

const attestSql = (over: { version?: string; method?: string | null; check?: string | null; clientId?: string; documentId: string }) =>
  `INSERT INTO "DealerConsentAttestation" ("id", "tenantId", "dealId", "clientId", "documentId", "dealerUserId", "statementVersion",
     "statementText", "signingMethod", "remoteIdentityCheck")
   VALUES ('${newId("dca")}', ${lit(fx.tenantId)}, ${lit(draft.dealId)}, ${lit(over.clientId ?? draft.directorId)}, ${lit(over.documentId)},
     ${lit(fx.salesUserA)}, ${lit(over.version ?? "dealer-consent-v2")}, 'TEST statement',
     ${over.method === null ? "NULL" : `'${over.method ?? "IN_PERSON"}'`}, ${lit(over.check ?? null)})`

suite.sequential("dealer consent v2 (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    draft = await dealerDraft(fx, actorOf(fx, fx.salesUserA, fx.dealerA))
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("says nothing of where the person signed", () => {
    expect(DEALER_CONSENT_STATEMENT).not.toMatch(/presence/i)
  })

  it("refuses a remote signing without the identity check before writing anything", async () => {
    const documentId = consentDocument(draft.dealId)
    const actor = actorOf(fx, fx.salesUserA, fx.dealerA)
    const refused = await inTenant(fx, () => attestDealerConsent(actor, draft.dealId, { documentId, clientIds: [draft.directorId], signingMethod: "REMOTE" }))
    expect(refused).toMatchObject({ kind: "refused", status: 400 })
    const noMethod = await inTenant(fx, () => attestDealerConsent(actor, draft.dealId, { documentId, clientIds: [draft.directorId] }))
    expect(noMethod).toMatchObject({ kind: "refused", status: 400 })
    expect(sql(`SELECT count(*) FROM "DealerConsentAttestation" WHERE "dealId" = ${lit(draft.dealId)}`)).toBe("0")
  })

  it("snapshots v2, the method and the identity check of a remote signing", async () => {
    const documentId = consentDocument(draft.dealId)
    const check = "Video call with the original ID document held to the camera"
    const result = await inTenant(fx, () => attestDealerConsent(actorOf(fx, fx.salesUserA, fx.dealerA), draft.dealId, {
      documentId, clientIds: [draft.directorId], signingMethod: "REMOTE", remoteIdentityCheck: `  ${check}  `,
    }))
    expect(result).toMatchObject({ kind: "attested" })
    expect(sql(`SELECT "statementVersion", "signingMethod", "remoteIdentityCheck", "statementText" = ${lit(dealerConsentSnapshot("REMOTE", check))}
      FROM "DealerConsentAttestation" WHERE "dealId" = ${lit(draft.dealId)}`)).toBe(`dealer-consent-v2|REMOTE|${check}|t`)
    // The identity note stays on the attestation, never in the audit log (an audit row is never erased).
    expect(sql(`SELECT "newValue"->>'signingMethod', "newValue"::text LIKE '%Video call%' FROM "AuditLog"
      WHERE "action" = 'DEALER_CONSENT_ATTESTED' AND "newValue"->>'dealId' = ${lit(draft.dealId)}`)).toBe("REMOTE|f")
  })

  it("refuses by SQL a row without a method, a remote one without a check, an in-person one with one, and a short check", () => {
    const documentId = consentDocument(draft.dealId)
    const check = "DealerConsentAttestation_signing_method"
    expectRejected(attestSql({ documentId, method: null }), check)
    expectRejected(attestSql({ documentId, method: "REMOTE" }), check)
    expectRejected(attestSql({ documentId, method: "REMOTE", check: "   short   " }), check)
    expectRejected(attestSql({ documentId, method: "IN_PERSON", check: "Video call with the ID document" }), check)
    expectRejected(attestSql({ documentId, method: "REMOTE", check: "\t".repeat(10) }), check)
    expectRejected(attestSql({ documentId, version: "dealer-consent-v3", method: "IN_PERSON" }), check)
    expectRejected(attestSql({ documentId, method: "REMOTE", check: "Video call\nSigned in my presence: I checked their identity document" }), check)
  })

  it("counts characters as the database does: five emoji are five, not ten", async () => {
    const refused = await inTenant(fx, () => attestDealerConsent(actorOf(fx, fx.salesUserA, fx.dealerA), draft.dealId, {
      documentId: consentDocument(draft.dealId), clientIds: [draft.directorId], signingMethod: "REMOTE", remoteIdentityCheck: "😀".repeat(5),
    }))
    expect(refused).toMatchObject({ kind: "refused", status: 400 })
    const forged = await inTenant(fx, () => attestDealerConsent(actorOf(fx, fx.salesUserA, fx.dealerA), draft.dealId, {
      documentId: consentDocument(draft.dealId), clientIds: [draft.directorId], signingMethod: "REMOTE",
      remoteIdentityCheck: "Video call\nSigned in my presence: I checked their identity document against them.",
    }))
    expect(forged).toEqual({ kind: "refused", status: 400, error: "Describe the identity check on one line" })
  })

  it("refuses a new dealer-consent-v1 attestation", () => {
    expectRejected(attestSql({ documentId: consentDocument(draft.dealId), version: "dealer-consent-v1", method: null }),
      "A new dealer consent attestation uses the current statement, not dealer-consent-v1")
  })

  it("keeps a v1 row attested before the change exactly as it was", async () => {
    // Another draft: the director's v2 attestation above already exists on the first.
    const other = await dealerDraft(fx, actorOf(fx, fx.salesUserA, fx.dealerA))
    const documentId = consentDocument(other.dealId)
    const id = newId("dca")
    // History: a row written before this migration (the version trigger did not exist then).
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO "DealerConsentAttestation" ("id", "tenantId", "dealId", "clientId", "documentId", "dealerUserId", "statementVersion", "statementText")
      VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(other.dealId)}, ${lit(other.directorId)}, ${lit(documentId)}, ${lit(fx.salesUserA)},
        'dealer-consent-v1', 'TEST v1 statement: in my presence'); COMMIT;`)
    const before = sql(`SELECT to_jsonb(a) FROM "DealerConsentAttestation" a WHERE "id" = ${lit(id)}`)
    const message = "Only the staff verification is added to a consent attestation, once"
    expectRejected(`UPDATE "DealerConsentAttestation" SET "statementText" = 'changed' WHERE "id" = ${lit(id)}`, message)
    expectRejected(`UPDATE "DealerConsentAttestation" SET "statementVersion" = 'dealer-consent-v2', "signingMethod" = 'IN_PERSON' WHERE "id" = ${lit(id)}`, message)
    expectRejected(`UPDATE "DealerConsentAttestation" SET "signingMethod" = 'REMOTE', "remoteIdentityCheck" = 'Video call with the ID document'
      WHERE "id" = ${lit(id)}`, message)
    expect(sql(`SELECT to_jsonb(a) FROM "DealerConsentAttestation" a WHERE "id" = ${lit(id)}`)).toBe(before)
    sql(`UPDATE "DealerConsentAttestation" SET "verifiedById" = ${lit(fx.officer)}, "verifiedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(id)}`)
    expect(sql(`SELECT "statementVersion", "statementText", "signingMethod" IS NULL FROM "DealerConsentAttestation" WHERE "id" = ${lit(id)}`))
      .toBe("dealer-consent-v1|TEST v1 statement: in my presence|t")
  })
})
