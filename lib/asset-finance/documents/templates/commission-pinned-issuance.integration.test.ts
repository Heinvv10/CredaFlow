/**
 * Real-Postgres proof that the introducer is pinned on issuance like the
 * lender's identity (slice 5 follow-ups part W, review round 1): the e-sign and
 * contract steps re-render the issued agreement from the input retained when
 * it was issued, never from the dealer as it is now. So a dealer renamed after
 * the documents were prepared (even to a name that would fail the shape rule)
 * does not stop anyone signing what they were shown, and an input retained
 * before the disclosure existed (no dealer key) still reproduces its PDF.
 *
 *   RUN_ASSET_TEMPLATES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/asset-finance/documents/templates/commission-pinned-issuance.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { insertDealer, insertDealerUser, lit } from "@/lib/dealer/dealer.integration-fixture"
import { saveFile } from "@/lib/storage"
import { verifiedSigningOtp } from "@/lib/signing-otp/signing-otp.integration-fixture"
import { ensureSyntheticTemplates } from "@/prisma/seed/asset-finance-templates"
import { dealFixtureTenantId } from "../../deal.integration-fixture"
import { cleanupSigningFixture, createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "../../deal-signing.integration-fixture"
import { plannedStartFor } from "../../first-due.test-helpers"
import { isoOfDbDate } from "../../dates"
import { ISA_CLAUSE } from "../commission-disclosure.test-helpers"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import { expectReproducibleIssuances } from "./templates.integration-fixture"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_TEMPLATES_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const ta = randomUUID().replaceAll("-", "").slice(0, 16)
const tb = randomUUID().replaceAll("-", "").slice(0, 16)
let a: SigningFixture
let b: SigningFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_TEMPLATES_IT=1 is required")
  return db
}
const asStaff = (fx: SigningFixture, userId: string, role: string) => {
  session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: fx.tenantId } }
}
const routes = (fx: SigningFixture) => signingRoutes(fx.host)
const signerOf = (fx: SigningFixture, document: "AGREEMENT" | "RESOLUTION" | "SURETYSHIP", clientId?: string) =>
  database().dealSigner.findFirstOrThrow({ where: { dealId: fx.dealId, document, ...(clientId ? { clientId } : {}) } })

async function setUp(fx: SigningFixture): Promise<void> {
  await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { ...SYNTHETIC_IDENTITY, isDemoLender: true } })
  await ensureSyntheticTemplates(fx.tenantId, { adminOne: { id: fx.adminA, email: "a@x.invalid" }, adminTwo: { id: fx.adminB, email: "b@x.invalid" } })
}
async function prepare(fx: SigningFixture): Promise<void> {
  asStaff(fx, fx.officer, "CREDIT_OFFICER")
  const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, select: { firstDueDate: true } })
  const response = await routes(fx).prepare(fx.dealId, { plannedStartDate: plannedStartFor(isoOfDbDate(deal.firstDueDate)) })
  expect(response.status, await response.clone().text()).toBe(200)
}
/** History, as the dealer fixtures write it: the deal is a dealer deal, handed over. Returns the dealer's id. */
function introduceBy(fx: SigningFixture, name: string): string {
  const dealerId = insertDealer(fx.tenantId, fx.adminA, { name })
  const dealerUserId = insertDealerUser(fx.tenantId, dealerId, { byUser: fx.adminA })
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE "AssetFinanceDeal" SET "dealerId" = ${lit(dealerId)}, "dealerUserId" = ${lit(dealerUserId)}, "createdById" = ${lit(dealerUserId)},
      "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(fx.dealId)}; COMMIT;`)
  return dealerId
}
const rename = (dealerId: string, nameSql: string) => sql(`UPDATE "Dealer" SET "name" = ${nameSql} WHERE "id" = ${lit(dealerId)}`)
async function eSign(fx: SigningFixture, document: "AGREEMENT" | "RESOLUTION"): Promise<Response> {
  const row = await signerOf(fx, document)
  session.current = { user: { id: row.clientId, email: `${row.clientId}@templates-it.test`, role: "CLIENT", tenantId: fx.tenantId } }
  const challenge = await verifiedSigningOtp(database(), { tenantId: fx.tenantId, clientId: row.clientId, purpose: "DEAL_DOCUMENT", subjectId: row.id, documentSha256: row.documentSha256! })
  return routes(fx).portalSign(row.id, { signature: "TEST Signs", documentSha256: row.documentSha256, signingOtpChallengeId: challenge })
}
const agreementText = async (fx: SigningFixture) => {
  const row = await signerOf(fx, "AGREEMENT")
  return prose(await texts(await readFile(row.documentStoragePath!))).replace(/\s+/g, " ")
}

suite.sequential("the introducer is pinned on issuance (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    const signIn = (fx: () => string) => (userId: string, role: string) => {
      session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: dealFixtureTenantId(fx()) } }
    }
    a = await createSigningFixture(database(), ta, signIn(() => ta), undefined, { templates: false })
    b = await createSigningFixture(database(), tb, signIn(() => tb), undefined, { templates: false })
    await setUp(a)
    await setUp(b)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    for (const t of [ta, tb]) {
      const tenantId = lit(dealFixtureTenantId(t))
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM "DealerUser" WHERE "tenantId" = ${tenantId}; DELETE FROM "Dealer" WHERE "tenantId" = ${tenantId}; COMMIT;`)
    }
    await cleanupSigningFixture(db, a ?? { tenantId: dealFixtureTenantId(ta) })
    await cleanupSigningFixture(db, b ?? { tenantId: dealFixtureTenantId(tb) })
    await db.$disconnect()
  })

  it("a dealer renamed after preparation, even to a name the shape rule refuses, does not stop e-signing or the contract step", async () => {
    const dealerId = introduceBy(a, "Original Dealer Motors")
    await prepare(a)
    const shown = await agreementText(a)
    expect(shown).toContain(`Introducer Original Dealer Motors (dealer) ${ISA_CLAUSE}`)
    // Renamed to a valid new name: the signer still signs the PDF they were shown.
    rename(dealerId, `'Renamed Dealer Motors'`)
    const signed = await eSign(a, "AGREEMENT")
    expect(signed.status, await signed.clone().text()).toBe(200)
    expect(await agreementText(a)).toBe(shown)
    // Renamed to a name that fails the shape rule (written past the staff routes): the contract step still reproduces what was issued.
    rename(dealerId, `'Mo' || chr(173) || 'tors'`)
    expect((await eSign(a, "RESOLUTION")).status).toBe(200)
    for (const row of await database().dealSigner.findMany({ where: { dealId: a.dealId, document: "SURETYSHIP" } })) {
      asStaff(a, a.officer, "CREDIT_OFFICER")
      expect((await routes(a).wetInk(a.dealId, row.id, "SIGNED_SURETYSHIP")).status).toBe(201)
      const scan = await database().dealSigner.findUniqueOrThrow({ where: { id: row.id } })
      asStaff(a, a.adminA, "LOAN_ADMIN")
      expect((await routes(a).confirm(a.dealId, row.id, scan.scanDocumentId!)).status).toBe(200)
    }
    asStaff(a, a.officer, "CREDIT_OFFICER")
    const contract = await routes(a).contract(a.dealId)
    expect(contract.status, await contract.clone().text()).toBe(200)
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: a.dealId } })).status).toBe("CONTRACTED")
    expect(await expectReproducibleIssuances(database(), a.tenantId, a.dealId)).toHaveLength(5)
  })

  it("an input retained before the disclosure existed (no dealer key) reproduces its PDF without the clause, though the deal now has a dealer", async () => {
    await prepare(b)
    const issuance = await database().assetDocumentIssuance.findFirstOrThrow({ where: { dealId: b.dealId, document: "AGREEMENT", supersededAt: null } })
    const retained = JSON.parse((await readFile(issuance.inputStoragePath!)).toString("utf8")) as { data: Record<string, unknown> }
    expect(retained.data).toHaveProperty("dealer", null)
    // As an issuance of the previous release holds it: the snapshot has no dealer key at all (written past the immutability trigger).
    delete retained.data.dealer
    const bytes = Buffer.from(JSON.stringify(retained), "utf8")
    const file = await saveFile(bytes, "application/json")
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE "AssetDocumentIssuance" SET "inputSha256" = ${lit(sha256DocumentBytes(bytes))}, "inputStoragePath" = ${lit(file.storagePath)} WHERE "id" = ${lit(issuance.id)}; COMMIT;`)
    introduceBy(b, "Late Dealer Motors")
    const shown = await agreementText(b)
    expect(shown).not.toContain("Introducer")
    expect(await expectReproducibleIssuances(database(), b.tenantId, b.dealId)).toHaveLength(5)
    const signed = await eSign(b, "AGREEMENT")
    expect(signed.status, await signed.clone().text()).toBe(200)
    expect(await agreementText(b)).toBe(shown)
  })
})
