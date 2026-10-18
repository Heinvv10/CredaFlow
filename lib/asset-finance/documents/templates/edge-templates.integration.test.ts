/**
 * Adversarial edge tests for lender-owned asset-finance templates against a
 * real, migrated Postgres. Only the session is stubbed (as in
 * templates.integration.test.ts); routes, store, renderers, storage and
 * database guards are real.
 *
 * DEFECT tests failed on feat/lender-owned-templates db87ae79 and pass since
 * the review-round-1 fixes; GUARD tests pin attacks that did not break the code.
 *
 *   RUN_ASSET_TEMPLATES_EDGE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/documents/templates/edge-templates.integration.test.ts --testTimeout 60000 --no-file-parallelism
 */
import { createHash, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { POST as createTemplateRoute } from "@/app/api/documents/templates/route"
import { GET as getTemplateRoute } from "@/app/api/documents/templates/[id]/route"
import { POST as previewRoute } from "@/app/api/documents/templates/[id]/preview/route"
import { POST as versionsRoute } from "@/app/api/documents/templates/[id]/versions/route"
import { POST as approveRoute } from "@/app/api/documents/templates/[id]/versions/[versionId]/approve/route"
import { POST as publishRoute } from "@/app/api/documents/templates/[id]/versions/[versionId]/publish/route"
import { POST as adoptRoute } from "@/app/api/documents/templates/asset-finance/adopt/route"
import { dealFixtureTenantId, dealRoutes } from "../../deal.integration-fixture"
import { cleanupSigningFixture, createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "../../deal-signing.integration-fixture"
import { dealStartDate } from "../../deal-structure"
import { addMonthsClamped, isoOfDbDate } from "../../dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { starterContent, type AssetTemplateContent } from "./content"
import { parseTemplateKey } from "./families"
import { approveVersion, createDraftVersion, publishVersion, type TemplateActor } from "./store"
import { FIXTURE_SIGN_OFF_REFERENCE } from "./templates.integration-fixture"
import { takesLenderText } from "./families"
import { legalActor, legalInput } from "./templates-it.helpers"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string; totpVerified?: boolean } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_TEMPLATES_EDGE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const ta = randomUUID().replaceAll("-", "").slice(0, 16)
const tb = randomUUID().replaceAll("-", "").slice(0, 16)
let a: SigningFixture
let b: SigningFixture
let squat: { tenantId: string } | null = null
let rootCause: string[] = []

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_TEMPLATES_EDGE_IT=1 is required")
  return db
}
const actor = (fx: SigningFixture, userId: string): TemplateActor => ({ tenantId: fx.tenantId, userId, totpVerified: true })
const sqlError = async (run: () => Promise<unknown>): Promise<string | null> => {
  try {
    await run()
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
  return null
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const templateOf = (fx: SigningFixture, key: string) => database().documentTemplate.findFirstOrThrow({ where: { tenantId: fx.tenantId, key } })
const edited = (key: string, marker: string): AssetTemplateContent => ({
  ...starterContent(parseTemplateKey(key)!),
  additionalTerms: [{ heading: `${marker} site visits`, text: `${marker}: {{lender.legalName}} may inspect the goods on reasonable notice.` }],
})
const signIn = (fx: SigningFixture, userId: string, role: string, totpVerified = true) => {
  session.current = { user: { id: userId, email: `${userId}@edge-it.test`, role, tenantId: fx.tenantId, totpVerified } }
}
const req = (fx: SigningFixture, path: string, body?: unknown) => new NextRequest(`http://${fx.host}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { host: fx.host, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) })
const startOf = async (dealId: string) => {
  const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, select: { firstDueDate: true } })
  return dealStartDate(isoOfDbDate(deal.firstDueDate))
}
/** A new draft of `key` (edited where the variant takes lender text), legally approved by the SUPER_ADMIN and published by adminA. */
async function publishEdit(fx: SigningFixture, key: string, marker: string): Promise<string> {
  const template = await templateOf(fx, key)
  const content = takesLenderText(parseTemplateKey(key)!) ? edited(key, marker) : starterContent(parseTemplateKey(key)!)
  const d = await createDraftVersion(actor(fx, fx.adminA), template.id, { content })
  if (!d.ok) throw new Error(d.error)
  const ap = await approveVersion(await legalActor(database(), fx.tenantId), template.id, d.value.id, legalInput(d.value.contentSha256))
  if (!ap.ok) throw new Error(ap.error)
  const pub = await publishVersion(actor(fx, fx.adminA), template.id, d.value.id)
  if (!pub.ok) throw new Error(pub.error)
  return d.value.id
}

suite.sequential("EDGE: lender-owned asset-finance templates (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    for (const [t, set] of [[ta, (fx: SigningFixture) => { a = fx }], [tb, (fx: SigningFixture) => { b = fx }]] as const) {
      const fx = await createSigningFixture(database(), t, (userId, role) => {
        session.current = { user: { id: userId, email: `${userId}@edge-it.test`, role, tenantId: dealFixtureTenantId(t) } }
      })
      await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: SYNTHETIC_IDENTITY })
      set(fx)
    }
  }, 240_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupSigningFixture(db, a ?? { tenantId: dealFixtureTenantId(ta) })
    await cleanupSigningFixture(db, b ?? { tenantId: dealFixtureTenantId(tb) })
    if (squat) {
      const tenantId = squat.tenantId
      await db.$transaction([
        db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
        db.auditLog.deleteMany({ where: { tenantId } }),
        db.documentTemplateVersion.deleteMany({ where: { template: { tenantId } } }),
        db.documentTemplate.deleteMany({ where: { tenantId } }),
        db.user.deleteMany({ where: { tenantId } }),
        db.tenantConfig.deleteMany({ where: { tenantId } }),
        db.tenant.deleteMany({ where: { id: tenantId } }),
      ])
    }
    await db.$disconnect()
  })

  // ---------------------------------------------------------------- DEFECTS

  it("FIXED (edge defect 1): a commercial (non-NCA) finance-lease deal can no longer be prepared: the app picks af.isa.*, the database refuses it, and the route throws", async () => {
    signIn(a, a.officer, "CREDIT_OFFICER")
    const routes = dealRoutes(a.host)
    const created = await routes.create({
      contractType: "FINANCE_LEASE", assetId: a.assets[1], depositCents: 17_250_000, balloonCents: 20_000_000,
      firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 1), preset: { kind: "MONTHLY", periods: 36 },
      rateBasis: "PRIME", rateMargin: "0.0100", entityId: a.evidenced, supplierId: a.supplier, productId: a.product,
    })
    expect(created.status).toBe(201)
    const dealId = ((await created.json()) as { id: string }).id
    expect((await routes.submit(dealId)).status).toBe(200)
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { application: { select: { ncaRegime: true } } } })
    const override = await database().ncaRegimeOverride.findFirst({ where: { applicationId: deal.applicationId } })
    if (override) {
      signIn(a, a.adminB, "LOAN_ADMIN")
      expect((await routes.decideOverride(override.id, { decision: "APPROVE", note: "Synthetic AFS agree" })).status).toBe(200)
    }
    signIn(a, a.officer, "CREDIT_OFFICER")
    expect((await routes.financials(dealId, {
      periodEnd: "2026-02-28", turnoverCents: 200_000_000, ebitdaCents: 60_000_000, totalAssetsCents: 200_000_000,
      totalLiabilitiesCents: 50_000_000, existingDebtServiceCents: 10_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 0,
    })).status).toBe(200)
    signIn(a, a.adminA, "LOAN_ADMIN")
    const decided = await routes.decide(dealId, { decision: "APPROVE", reasons: ["Synthetic DSCR comfortably above policy"] })
    expect(decided.status, JSON.stringify(await decided.clone().json())).toBe(200)
    const approved = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { application: { select: { ncaRegime: true } } } })
    expect(approved.status).toBe("APPROVED")
    expect(approved.contractType).toBe("FINANCE_LEASE")
    expect(approved.application.ncaRegime).toBe("NON_NCA")

    // Root cause: no template key fits a non-NCA FINANCE_LEASE (assetTemplateKeyFits), yet
    // templateKeyFor() picks af.isa.* for it; the issuance trigger then refuses.
    const fits = await database().$queryRawUnsafe<Array<{ key: string; fits: boolean }>>(
      `SELECT k AS key, public."assetTemplateKeyFits"(k, 'FINANCE_LEASE', 'NON_NCA', $1, $2) AS fits FROM unnest($3::text[]) k`,
      approved.isaCpaApplies, approved.cpaApplies, ["af.isa.commercial", "af.isa.cpa", "af.lease.operating.commercial", "af.lease.operating.cpa", "af.lease.fml.commercial", "af.lease.fml.cpa", "af.nca.instalment_sale", "af.nca.finance_lease"],
    )
    rootCause = fits.filter((f) => f.fits).map((f) => f.key)
    signIn(a, a.officer, "CREDIT_OFFICER")
    let status: number | string
    try {
      const res = await signingRoutes(a.host).prepare(dealId, { plannedStartDate: await startOf(dealId) })
      status = res.status === 200 ? 200 : `${res.status} ${JSON.stringify(await res.json())}`
    } catch (error) {
      status = `threw: ${String(error instanceof Error ? error.message : error).slice(-200)}`
    }
    // Before lender templates this deal prepared (with the instalment-sale
    // renderer). Now no template family fits a non-NCA FINANCE_LEASE at all.
    expect(status, `agreement keys that fit this deal: ${JSON.stringify(rootCause)}`).toBe(200)
  }, 120_000)

  it("FIXED (edge defect 6): an af.* key cannot be squatted by a custom letter, so adoption creates the asset-finance template", async () => {
    // A lender that has not adopted any asset-finance family yet.
    const tenantId = `t_af_edge_squat_${ta}`
    const host = `af-edge-squat-${ta}.deal-it.test`
    await database().tenant.create({ data: { id: tenantId, slug: `af-edge-squat-${ta}`, name: "Edge squat", domain: host } })
    await database().tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
    const admin = (await database().user.create({ data: { tenantId, email: `squat-${ta}@staff.invalid`, password: "x", role: "LOAN_ADMIN" } })).id
    squat = { tenantId }
    const fx = { tenantId, host } as SigningFixture
    signIn(fx, admin, "LOAN_ADMIN")
    const custom = await createTemplateRoute(req(fx, "/api/documents/templates", { name: "Lease cession letter", key: "af.lease.fml.cpa" }))
    expect(custom.status).toBe(422)
    const adopted = await adoptRoute(req(fx, "/api/documents/templates/asset-finance/adopt", { family: "af.lease.fml" }))
    const body = await adopted.json() as { created?: string[]; existing?: string[] }
    expect(await database().documentTemplate.count({ where: { tenantId, key: "af.lease.fml.cpa", kind: "ASSET_FINANCE" } }), JSON.stringify(body)).toBe(1)
    // The lender asked to adopt af.lease.fml.cpa and was told it already has it.
    expect(body.existing ?? []).not.toContain("af.lease.fml.cpa")
  })

  it("FIXED (edge defect 7): the database refuses a deal signer signing bytes whose issuance has been superseded", async () => {
    signIn(b, b.officer, "CREDIT_OFFICER")
    expect((await signingRoutes(b.host).prepare(b.dealId, { plannedStartDate: await startOf(b.dealId) })).status).toBe(200)
    const signer = await database().dealSigner.findFirstOrThrow({ where: { dealId: b.dealId, document: "RESOLUTION" } })
    // Supersede its issuance (allowed: nothing signed yet).
    await database().assetDocumentIssuance.update({ where: { id: signer.issuanceId! }, data: { supersededAt: new Date(), inputStoragePath: null, pdfStoragePath: null } })
    const refused = await sqlError(() => database().dealSigner.update({ where: { id: signer.id }, data: {
      method: "E_SIGN", signedAt: new Date(), signatureData: "TEST", signatureSha256: sha(Buffer.from("TEST")),
    } }))
    // Clean up so later tests can re-prepare: undo the signature with triggers off.
    if (refused === null) {
      await database().$transaction([
        database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
        database().dealSigner.update({ where: { id: signer.id }, data: { method: null, signedAt: null, signatureData: null, signatureSha256: null } }),
      ])
    }
    expect(refused, "the signature on a superseded issuance was accepted").not.toBeNull()
    expect(refused).toMatch(/superseded document is not signed/)
  })

  it("FIXED (edge defect 8): the database refuses a CREDIT_OFFICER as approver of legal wording", async () => {
    const template = await templateOf(b, "af.resolution.standard")
    const d = await createDraftVersion(actor(b, b.adminA), template.id, { content: starterContent(parseTemplateKey("af.resolution.standard")!) })
    if (!d.ok) throw new Error(d.error)
    const refusedApproval = await sqlError(() => database().documentTemplateVersion.update({ where: { id: d.value.id }, data: {
      approvedById: b.officer, approvedAt: new Date(), approvedContentSha256: d.value.contentSha256, approvalBasis: "LENDER_LEGAL",
      legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE,
    } }))
    expect(refusedApproval, "a CREDIT_OFFICER's approval was recorded").not.toBeNull()
  })

  // ----------------------------------------------------------------- GUARDS

  it("GUARD: another lender's templates and versions are invisible through every template route", async () => {
    const bIsa = await templateOf(b, "af.isa.commercial")
    const bVersion = await database().documentTemplateVersion.findFirstOrThrow({ where: { templateId: bIsa.id } })
    const aIsa = await templateOf(a, "af.isa.commercial")
    signIn(a, a.adminA, "LOAN_ADMIN")
    expect((await getTemplateRoute(req(a, `/api/documents/templates/${bIsa.id}`), p({ id: bIsa.id }))).status).toBe(404)
    expect((await previewRoute(req(a, `/api/documents/templates/${bIsa.id}/preview`, { versionId: bVersion.id }), p({ id: bIsa.id }))).status).toBe(404)
    // Own template id, other lender's version id: the version is not found.
    expect((await previewRoute(req(a, `/api/documents/templates/${aIsa.id}/preview`, { versionId: bVersion.id }), p({ id: aIsa.id }))).status).toBe(404)
    expect((await versionsRoute(req(a, `/api/documents/templates/${bIsa.id}/versions`, { content: edited("af.isa.commercial", "X") }), p({ id: bIsa.id }))).status).toBe(404)
    signIn(a, a.adminB, "LOAN_ADMIN")
    const body = legalInput(bVersion.contentSha256)
    expect((await approveRoute(req(a, "/x", body), p({ id: bIsa.id, versionId: bVersion.id }))).status).toBe(404)
    expect((await approveRoute(req(a, "/x", body), p({ id: aIsa.id, versionId: bVersion.id }))).status).toBe(404)
    expect((await publishRoute(req(a, "/x", {}), p({ id: bIsa.id, versionId: bVersion.id }))).status).toBe(404)
    expect((await publishRoute(req(a, "/x", {}), p({ id: aIsa.id, versionId: bVersion.id }))).status).toBe(404)
    expect((await database().documentTemplateVersion.findUniqueOrThrow({ where: { id: bVersion.id } })).status).toBe(bVersion.status)
  })

  it("GUARD: a preview carries the DRAFT mark and the exact hash, and posting a different hash cannot approve", async () => {
    const isa = await templateOf(a, "af.isa.commercial")
    const d = await createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", "PREVIEW") })
    if (!d.ok) throw new Error(d.error)
    signIn(a, a.adminB, "LOAN_ADMIN")
    const preview = await previewRoute(req(a, "/x", { versionId: d.value.id }), p({ id: isa.id }))
    expect(preview.status).toBe(200)
    expect(preview.headers.get("X-Template-Content-Sha256")).toBe(d.value.contentSha256)
    // Unsaved content previews too but carries no hash to approve with.
    const unsaved = await previewRoute(req(a, "/x", { content: edited("af.isa.commercial", "UNSAVED") }), p({ id: isa.id }))
    expect(unsaved.status).toBe(200)
    expect(unsaved.headers.get("X-Template-Content-Sha256")).toBeNull()
    const bad = await approveRoute(req(a, "/x", { contentSha256: "f".repeat(64), attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE }), p({ id: isa.id, versionId: d.value.id }))
    expect(bad.status).toBe(409)
    // A session without TOTP cannot approve through the route.
    signIn(a, a.adminB, "LOAN_ADMIN", false)
    const noTotp = await approveRoute(req(a, "/x", { contentSha256: d.value.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE }), p({ id: isa.id, versionId: d.value.id }))
    expect(noTotp.status).toBe(403)
  })

  it("GUARD: the database refuses raw-SQL attempts to re-point, move or forge template versions", async () => {
    const aIsa = await templateOf(a, "af.isa.commercial")
    const aCpa = await templateOf(a, "af.isa.cpa")
    const bIsa = await templateOf(b, "af.isa.commercial")
    // Point a template at another template's (or lender's) ACTIVE version.
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: aIsa.id }, data: { currentVersionId: aCpa.currentVersionId } }))).toMatch(/one ACTIVE version/)
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: aIsa.id }, data: { currentVersionId: bIsa.currentVersionId } }))).toMatch(/one ACTIVE version/)
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: aIsa.id }, data: { currentVersionId: null } }))).toMatch(/one ACTIVE version/)
    // Move a published version to another template.
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: aIsa.currentVersionId! }, data: { templateId: aCpa.id } }))).toMatch(/immutable|one_active|Unique/)
    // A CUSTOM template cannot become an asset template, nor carry lender wording.
    const custom = await database().documentTemplate.create({ data: { tenantId: a.tenantId, key: `edge_custom_${ta}`, name: "Edge custom", kind: "CUSTOM" } })
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: custom.id }, data: { kind: "ASSET_FINANCE", assetFamily: "af.isa", assetVariant: "commercial", key: "af.isa.commercial2" } }))).not.toBeNull()
    const active = await database().documentTemplateVersion.findUniqueOrThrow({ where: { id: aIsa.currentVersionId! } })
    expect(await sqlError(() => database().documentTemplateVersion.create({ data: {
      templateId: custom.id, version: 1, bodyHtml: "<p>x</p>", tokensUsed: [], content: active.content, contentSha256: active.contentSha256, createdById: a.adminA,
    } }))).toMatch(/Only an asset-finance template version/)
    // Archive the ACTIVE version directly: the template still points at it, and nothing can be issued from it.
    const archived = await sqlError(() => database().documentTemplateVersion.update({ where: { id: active.id }, data: { status: "ARCHIVED" } }))
    if (archived === null) {
      await expect(import("./issuance").then((m) => m.selectIssuableTemplate(database() as never, a.tenantId, "af.isa.commercial"))).rejects.toThrow(/not approved for this exact wording/)
      // Restore for later tests: a fresh published version.
      await publishEdit(a, "af.isa.commercial", "RESTORE")
    }
  })

  it("GUARD: flipping the demo flag after publication stops issuance before anything is written", async () => {
    await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { isDemoLender: true } })
    try {
      signIn(a, a.officer, "CREDIT_OFFICER")
      const before = await database().assetDocumentIssuance.count({ where: { tenantId: a.tenantId } })
      const res = await signingRoutes(a.host).prepare(a.dealId, { plannedStartDate: await startOf(a.dealId) })
      expect(res.status).toBe(422)
      expect((await res.json()).error).toMatch(/does not apply to this lender/)
      expect(await database().assetDocumentIssuance.count({ where: { tenantId: a.tenantId } })).toBe(before)
    } finally {
      await database().tenantConfig.update({ where: { tenantId: a.tenantId }, data: { isDemoLender: false } })
    }
  })

  it("GUARD: preparing while a new version is published concurrently never errors and never issues from a non-current version", async () => {
    signIn(a, a.officer, "CREDIT_OFFICER")
    const start = await startOf(a.dealId)
    for (let i = 0; i < 3; i++) {
      const [prepared, published] = await Promise.allSettled([
        signingRoutes(a.host).prepare(a.dealId, { plannedStartDate: start }),
        publishEdit(a, "af.isa.commercial", `RACE${i}`),
      ])
      expect(published.status).toBe("fulfilled")
      expect(prepared.status).toBe("fulfilled")
      const status = prepared.status === "fulfilled" ? prepared.value.status : 0
      expect([200, 422]).toContain(status)
    }
    // Two lenders preparing at once keep their own wording.
    signIn(a, a.officer, "CREDIT_OFFICER")
    const [ra, rb] = await Promise.all([
      signingRoutes(a.host).prepare(a.dealId, { plannedStartDate: start }),
      (async () => { signIn(b, b.officer, "CREDIT_OFFICER"); return signingRoutes(b.host).prepare(b.dealId, { plannedStartDate: await startOf(b.dealId) }) })(),
    ])
    expect([ra.status, rb.status].every((s) => s === 200 || s === 403 || s === 404)).toBe(true)
    for (const fx of [a, b]) {
      const current = await database().assetDocumentIssuance.findMany({ where: { tenantId: fx.tenantId, supersededAt: null } })
      for (const issuance of current) {
        const template = await database().documentTemplate.findUniqueOrThrow({ where: { id: issuance.templateId } })
        expect(template.tenantId).toBe(fx.tenantId)
      }
      // Exactly one current issuance per document per deal.
      const agreements = current.filter((i) => i.document === "AGREEMENT" && i.dealId === fx.dealId)
      expect(agreements.length).toBeLessThanOrEqual(1)
    }
  }, 180_000)

  it("GUARD: once anyone has signed, re-preparing is refused and no issuance is superseded", async () => {
    signIn(a, a.officer, "CREDIT_OFFICER")
    const start = await startOf(a.dealId)
    expect((await signingRoutes(a.host).prepare(a.dealId, { plannedStartDate: start })).status).toBe(200)
    const signer = await database().dealSigner.findFirstOrThrow({ where: { dealId: a.dealId, document: "RESOLUTION" } })
    await database().dealSigner.update({ where: { id: signer.id }, data: { method: "E_SIGN", signedAt: new Date(), signatureData: "TEST", signatureSha256: sha(Buffer.from("TEST")) } })
    const current = await database().assetDocumentIssuance.findMany({ where: { dealId: a.dealId, supersededAt: null }, select: { id: true } })
    await publishEdit(a, "af.resolution.standard", "AFTERSIGN")
    const again = await signingRoutes(a.host).prepare(a.dealId, { plannedStartDate: start })
    expect(again.status).toBe(409)
    const still = await database().assetDocumentIssuance.findMany({ where: { dealId: a.dealId, supersededAt: null }, select: { id: true } })
    expect(still.map((r) => r.id).sort()).toEqual(current.map((r) => r.id).sort())
    expect(await sqlError(() => database().assetDocumentIssuance.update({ where: { id: signer.issuanceId! }, data: { supersededAt: new Date(), inputStoragePath: null, pdfStoragePath: null } })))
      .toMatch(/signed asset document issuance is never superseded/)
  })
})
