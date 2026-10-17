/**
 * Real-Postgres proof of deal documents and signing (goal §4.9, decision
 * 2a.5): preparation binds stored PDFs by sha256; a SURETY-only client reads
 * and e-signs their own suretyship and gets 404 on the agreement and on
 * another surety's document; wet ink needs a second user (route AND CHECK);
 * signed rows are frozen; CONTRACTED is refused — by the route and by the
 * database trigger — while any required signer is outstanding or missing.
 *
 * Only the session is stubbed. Routes, role guard, tenant resolution (by
 * host), feature flag, renderer, storage, audit and access-log writers,
 * triggers and CHECKs are real.
 *
 *   RUN_ASSET_FINANCE_SIGNING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/deal-signing.integration.test.ts
 */
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { PrismaClient, type DealDocumentKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleRefuses } from "./lease-servicing.integration-fixture"
import { dealFixtureTenantId } from "./deal.integration-fixture"
import { cleanupSigningFixture, createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "./deal-signing.integration-fixture"
import { dealStartDate } from "./deal-structure"
import { isoOfDbDate } from "./dates"
import { verifiedSigningOtp } from "@/lib/signing-otp/signing-otp.integration-fixture"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_SIGNING_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: SigningFixture
let plannedStart = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_SIGNING_IT=1 is required")
  return db
}
const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@signing-it.test`, role, tenantId: fx.tenantId } }
}
const asClient = (clientId: string) => {
  session.current = { user: { id: clientId, email: `${clientId}@signing-it.test`, role: "CLIENT", tenantId: fx.tenantId } }
}
const routes = () => signingRoutes(fx.host)
const signerOf = (clientId: string, document: DealDocumentKind) =>
  database().dealSigner.findUniqueOrThrow({ where: { dealId_clientId_document: { dealId: fx.dealId, clientId, document } } })
// The lender requires a signing code by default: each e-signature carries a
// verified one, bound to that signer row and those bytes.
const otpFor = (row: { id: string; clientId: string; documentSha256: string | null }) => verifiedSigningOtp(database(), {
  tenantId: fx.tenantId, clientId: row.clientId, purpose: "DEAL_DOCUMENT", subjectId: row.id, documentSha256: row.documentSha256!,
})
const sign = async (clientId: string, document: DealDocumentKind) => {
  const row = await signerOf(clientId, document)
  asClient(clientId)
  return routes().portalSign(row.id, {
    signature: `TEST ${clientId.slice(0, 6)} signs`, documentSha256: row.documentSha256, signingOtpChallengeId: await otpFor(row),
  })
}
const sqlError = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
  throw new Error("expected the database to refuse")
}
const forceContract = () => database().assetFinanceDeal.update({ where: { id: fx.dealId }, data: { status: "CONTRACTED" } })

suite.sequential("asset-finance deal signing (real Postgres, real routes)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    session.current = null
    fx = await createSigningFixture(database(), t, (userId, role) => {
      session.current = { user: { id: userId, email: `${userId}@signing-it.test`, role, tenantId: `t_af_deal_${t}` } }
    })
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, select: { firstDueDate: true } })
    plannedStart = dealStartDate(isoOfDbDate(deal.firstDueDate))
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupSigningFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("refuses to prepare documents while the lender identity is not configured (422, nothing written)", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().prepare(fx.dealId, { plannedStartDate: plannedStart })
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/Lender identity is not configured/)
    expect(await database().dealSigner.count({ where: { dealId: fx.dealId } })).toBe(0)
  })

  it("prepares: one row per required signature, each binding stored bytes by sha256; again is idempotent", async () => {
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: SYNTHETIC_IDENTITY })
    signIn(fx.officer, "CREDIT_OFFICER")
    expect((await routes().prepare(fx.dealId, { plannedStartDate: plannedStart })).status).toBe(200)
    const rows = await database().dealSigner.findMany({ where: { dealId: fx.dealId } })
    expect(rows.map((r) => `${r.document}:${r.clientId}:${r.role}`).sort()).toEqual([
      `AGREEMENT:${fx.director}:AUTHORISED_SIGNATORY`, `RESOLUTION:${fx.director}:AUTHORISED_SIGNATORY`,
      `SURETYSHIP:${fx.director}:SURETY`, `SURETYSHIP:${fx.suretyA}:SURETY`, `SURETYSHIP:${fx.suretyB}:SURETY`,
    ].sort())
    for (const row of rows) {
      const bytes = await readFile(row.documentStoragePath ?? "")
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.documentSha256)
    }
    expect(new Set(rows.filter((r) => r.document === "SURETYSHIP").map((r) => r.documentSha256)).size).toBe(3)

    expect((await routes().prepare(fx.dealId, { plannedStartDate: plannedStart })).status).toBe(200)
    const again = await database().dealSigner.findMany({ where: { dealId: fx.dealId } })
    expect(again.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort())
    // Deterministic render: the same deal binds the same digests.
    expect(again.map((r) => r.documentSha256).sort()).toEqual(rows.map((r) => r.documentSha256).sort())
    expect(await database().auditLog.count({ where: { entityId: fx.dealId, action: "ASSET_DEAL_DOCUMENTS_PREPARED" } })).toBe(2)
  })

  it("a SURETY-only client reads their own suretyship (logged) but gets 404 on the agreement and another surety's", async () => {
    const own = await signerOf(fx.suretyA, "SURETYSHIP")
    const agreement = await signerOf(fx.director, "AGREEMENT")
    const other = await signerOf(fx.suretyB, "SURETYSHIP")
    asClient(fx.suretyA)
    const response = await routes().portalDocument(own.id)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect((await database().documentAccessLog.findMany({ where: { documentId: own.id } }))).toEqual([
      expect.objectContaining({ accessorType: "client", accessorId: fx.suretyA, action: "view" }),
    ])
    for (const id of [agreement.id, other.id]) {
      expect((await routes().portalDocument(id)).status).toBe(404)
      expect((await routes().portalSign(id, { signature: "TEST Surety A", documentSha256: other.documentSha256 })).status).toBe(404)
      expect(await database().documentAccessLog.count({ where: { documentId: id } })).toBe(0)
    }
    expect((await database().dealSigner.findUniqueOrThrow({ where: { id: other.id } })).method).toBeNull()
  })

  it("refuses an e-signature without a verified code, or with a code for another document, and changes nothing", async () => {
    const own = await signerOf(fx.director, "AGREEMENT")
    const other = await signerOf(fx.director, "RESOLUTION")
    asClient(fx.director)
    const bare = await routes().portalSign(own.id, { signature: "TEST Surety A", documentSha256: own.documentSha256 })
    expect(bare.status).toBe(403)
    expect(await bare.json()).toEqual(expect.objectContaining({ signingOtp: "required" }))
    const wrongBytes = await verifiedSigningOtp(database(), {
      tenantId: fx.tenantId, clientId: fx.director, purpose: "DEAL_DOCUMENT", subjectId: own.id, documentSha256: "0".repeat(64),
    })
    expect((await routes().portalSign(own.id, {
      signature: "TEST Surety A", documentSha256: own.documentSha256, signingOtpChallengeId: wrongBytes,
    })).status).toBe(409)
    const wrongRow = await verifiedSigningOtp(database(), {
      tenantId: fx.tenantId, clientId: fx.director, purpose: "DEAL_DOCUMENT", subjectId: other.id, documentSha256: own.documentSha256!,
    })
    expect((await routes().portalSign(own.id, {
      signature: "TEST Surety A", documentSha256: own.documentSha256, signingOtpChallengeId: wrongRow,
    })).status).toBe(403)
    expect((await signerOf(fx.director, "AGREEMENT")).method).toBeNull()
  })

  it("e-signs: a stale digest is refused, the signature is stored with its sha256 and IP, audited, once", async () => {
    const own = await signerOf(fx.director, "AGREEMENT")
    asClient(fx.director)
    expect((await routes().portalSign(own.id, { signature: "TEST Surety A", documentSha256: "0".repeat(64) })).status).toBe(409)
    const challengeId = await otpFor(own)
    const response = await routes().portalSign(own.id, {
      signature: "TEST Surety A", documentSha256: own.documentSha256, signingOtpChallengeId: challengeId,
    })
    expect(response.status).toBe(200)
    expect(await database().signingOtpChallenge.findUniqueOrThrow({ where: { id: challengeId } }))
      .toMatchObject({ consumedAt: expect.any(Date), signingMethod: "portal" })
    expect(await database().auditLog.findFirst({ where: { entityId: own.id, action: "ASSET_DEAL_DOCUMENT_SIGNED" } }))
      .toMatchObject({ newValue: expect.objectContaining({ signingOtp: expect.objectContaining({ challengeId }) }) })
    const signed = await signerOf(fx.director, "AGREEMENT")
    expect(signed).toMatchObject({
      method: "E_SIGN", signatureData: "TEST Surety A", signedByIp: "198.51.100.7",
      signatureSha256: createHash("sha256").update("TEST Surety A").digest("hex"),
    })
    expect(await database().auditLog.count({ where: { entityId: own.id, action: "ASSET_DEAL_DOCUMENT_SIGNED" } })).toBe(1)
    expect((await routes().portalSign(own.id, { signature: "TEST again", documentSha256: own.documentSha256 })).status).toBe(409)
  })

  it("a signed row is immutable and never deleted (trigger)", async () => {
    const own = await signerOf(fx.director, "AGREEMENT")
    expect(await sqlError(() => database().dealSigner.update({ where: { id: own.id }, data: { signatureData: "forged" } })))
      .toContain("A signed or confirmed deal signer is immutable")
    expect(await sqlError(() => database().dealSigner.delete({ where: { id: own.id } })))
      .toContain("A signed or confirmed deal signer is immutable")
  })

  it("contract is refused (route 409 listing them, and by the DB) while one surety is unsigned", async () => {
    expect((await sign(fx.director, "RESOLUTION")).status).toBe(200)
    for (const clientId of [fx.director, fx.suretyA]) {
      const row = await signerOf(clientId, "SURETYSHIP")
      asClient(clientId)
      expect((await routes().portalSign(row.id, { signature: "TEST Surety", documentSha256: row.documentSha256 })).status).toBe(409)
      await ruleRefuses(database(), { table: "DealSigner", trigger: "DealSigner_surety_wet_ink" }, /Suretyships require wet ink/, (tx) => tx.dealSigner.update({ where: { id: row.id }, data: { method: "E_SIGN", signedAt: new Date(), signatureData: "TEST Surety", signatureSha256: createHash("sha256").update("TEST Surety").digest("hex") } }))
      signIn(fx.officer, "CREDIT_OFFICER")
      expect((await routes().wetInk(fx.dealId, row.id, "SIGNED_SURETYSHIP")).status).toBe(201)
      const scan = await signerOf(clientId, "SURETYSHIP")
      signIn(fx.adminA, "LOAN_ADMIN")
      expect((await routes().confirm(fx.dealId, row.id, scan.scanDocumentId!)).status).toBe(200)
    }
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().contract(fx.dealId)
    expect(response.status).toBe(409)
    expect((await response.json()).outstanding).toEqual([
      expect.objectContaining({ clientId: fx.suretyB, document: "SURETYSHIP", state: "PENDING", name: "TEST suretyb" }),
    ])
    expect(await sqlError(forceContract)).toContain("Every deal signer must have e-signed or have a confirmed wet-ink scan")
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } })).status).toBe("APPROVED")
  })

  it("wet ink: the uploader cannot confirm (route 403 audited; CHECK in the DB); a second user can", async () => {
    const row = await signerOf(fx.suretyB, "SURETYSHIP")
    signIn(fx.officer, "CREDIT_OFFICER")
    expect((await routes().wetInk(fx.dealId, row.id, "SIGNED_AGREEMENT")).status).toBe(400)
    expect((await routes().wetInk(fx.dealId, row.id, "SIGNED_SURETYSHIP")).status).toBe(201)
    const uploaded = await signerOf(fx.suretyB, "SURETYSHIP")
    expect(uploaded).toMatchObject({ method: "WET_INK", scanUploadedById: fx.officer, confirmedById: null })
    if (!uploaded.scanDocumentId) throw new Error("wet-ink scan was not bound to the signer")

    expect((await routes().confirm(fx.dealId, row.id, uploaded.scanDocumentId)).status).toBe(403)
    expect(await database().auditLog.count({ where: { entityId: fx.dealId, action: "ASSET_DEAL_SIGNING_REFUSED" } })).toBeGreaterThan(0)
    expect(await sqlError(() => database().dealSigner.update({
      where: { id: row.id }, data: { confirmedById: fx.officer, confirmedAt: new Date() },
    }))).toContain("DealSigner_wet_ink_four_eyes")
    expect(await sqlError(() => database().entityDocument.update({
      where: { id: uploaded.scanDocumentId ?? "" }, data: { deletedAt: new Date() },
    }))).toContain("A signed scan on record for a deal signer cannot be deleted")

    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().confirm(fx.dealId, row.id, uploaded.scanDocumentId)).status).toBe(200)
    expect(await signerOf(fx.suretyB, "SURETYSHIP")).toMatchObject({ confirmedById: fx.adminA })
  })

  it("the prepared signer set is fixed: no surety is added after approval, and a prepared surety cannot be deactivated (DB)", async () => {
    const late = await database().client.create({
      data: {
        tenantId: fx.tenantId, firstName: "TEST", lastName: "late", email: `late-${t}@client.invalid`,
        phone: `0002${t.slice(0, 6)}`, idNumber: `97${t.replace(/\D/g, "0").slice(0, 11)}`,
      },
    })
    // Fair Score E5: the approval cross-checked the entity's people; none is added after it.
    expect(await sqlError(() => database().entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId: late.id, role: "SURETY" } })))
      .toContain("The entity has an approved deal: no director, trustee, surety or other party is added or reactivated")
    expect(await sqlError(() => database().entityRelationship.updateMany({
      where: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId: fx.suretyB, role: "SURETY" }, data: { active: false },
    }))).toContain("The entity has a deal under review or approved: its directors, trustees, sureties and other parties are fixed")
    signIn(fx.officer, "CREDIT_OFFICER")
    expect((await routes().prepare(fx.dealId, { plannedStartDate: plannedStart })).status).toBe(409)
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } })
    expect(deal.preparedSigners).not.toContainEqual(expect.objectContaining({ clientId: late.id }))
  })

  it("all prepared signers satisfied → CONTRACTED, audited; signer rows are then closed to change", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().contract(fx.dealId)
    expect(response.status).toBe(200)
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } })).status).toBe("CONTRACTED")
    expect(await database().auditLog.count({ where: { entityId: fx.dealId, action: "ASSET_DEAL_CONTRACTED", userId: fx.officer } })).toBe(1)
    expect((await routes().prepare(fx.dealId, { plannedStartDate: plannedStart })).status).toBe(409)
    expect(await sqlError(() => database().dealSigner.create({
      data: {
        tenantId: fx.tenantId, dealId: fx.dealId, clientId: fx.suretyA, role: "AUTHORISED_SIGNATORY", document: "AGREEMENT",
        documentSha256: "a".repeat(64), documentStoragePath: "/nowhere.pdf",
      },
    }))).toContain("Deal signers change only while the deal is APPROVED")
    asClient(fx.suretyA)
    expect((await routes().portalDocument((await signerOf(fx.suretyA, "SURETYSHIP")).id)).status).toBe(200)
  })
})
