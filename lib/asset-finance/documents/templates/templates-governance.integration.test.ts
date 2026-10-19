/**
 * Real-Postgres proof of lender-owned asset-finance template governance
 * (docs/asset-finance/evidence/lender-owned-templates/SPEC.md §3): adoption,
 * immutable hashed versions, exact-content approval by someone other than
 * the author (a SUPER_ADMIN for a legal approval), demo versus legal basis,
 * publication by someone other than the approver, one ACTIVE version, races,
 * tenant isolation and the template routes' guards.
 *
 * Only the session is stubbed. Routes, store, triggers, CHECKs and the
 * partial unique index are real.
 *
 *   RUN_ASSET_TEMPLATES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/documents/templates/templates-governance.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "../../deal.integration-fixture"
import { SYNTHETIC_IDENTITY } from "../../deal-signing.integration-fixture"
import { TemplateUnavailableError, generateDocument } from "@/lib/documents/render"
import { canonicalContent, contentSha256, starterContent } from "./content"
import { parseTemplateKey } from "./families"
import { systemFingerprint } from "./fingerprint"
import { selectIssuableTemplate } from "./issuance"
import { ensureSyntheticTemplates } from "@/prisma/seed/asset-finance-templates"
import { adoptStarter, approveVersion, createDraftVersion, publishVersion, type TemplateActor } from "./store"
import { draftApprovePublish, edited, latest, legalActor, legalInput, sqlError, templateOf, templateRoutes } from "./templates-it.helpers"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string; totpVerified?: boolean } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_TEMPLATES_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const ta = randomUUID().replaceAll("-", "").slice(0, 16)
const tb = randomUUID().replaceAll("-", "").slice(0, 16)
const tc = randomUUID().replaceAll("-", "").slice(0, 16)
let a: DealFixture
let b: DealFixture
let c: DealFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_TEMPLATES_IT=1 is required")
  return db
}
const appDb = () => database() as unknown as typeof import("@/lib/prisma").prisma
const actor = (fx: DealFixture, userId: string, totpVerified = true): TemplateActor => ({ tenantId: fx.tenantId, userId, totpVerified })
const signIn = (fx: DealFixture, userId: string, role: string, totpVerified?: boolean) => {
  session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: fx.tenantId, ...(totpVerified ? { totpVerified } : {}) } }
}
const tpl = (fx: DealFixture, key: string) => templateOf(database(), fx.tenantId, key)

suite.sequential("lender-owned asset-finance template governance (real Postgres)", () => {
  beforeAll(async () => {
    a = await createDealFixture(database(), ta, { templates: false })
    b = await createDealFixture(database(), tb, { templates: false })
    for (const fx of [a, b]) await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: SYNTHETIC_IDENTITY })
  })

  afterAll(async () => {
    if (!db) return
    await cleanupDealFixture(db, a ?? { tenantId: dealFixtureTenantId(ta) })
    await cleanupDealFixture(db, b ?? { tenantId: dealFixtureTenantId(tb) })
    await cleanupDealFixture(db, c ?? { tenantId: dealFixtureTenantId(tc) })
    await db.$disconnect()
  })

  it("adoption is a LOAN_ADMIN's, per lender, idempotent under concurrency, and never copies another lender's wording", async () => {
    signIn(a, a.officer, "CREDIT_OFFICER")
    expect((await templateRoutes(a.host).adopt("af.isa")).status).toBe(403)
    signIn(a, a.adminA, "LOAN_ADMIN")
    const [first, second] = await Promise.all([templateRoutes(a.host).adopt("af.isa"), adoptStarter(actor(a, a.adminA), "af.isa")])
    expect(first.status).toBe(200)
    expect(second.ok).toBe(true)
    expect(await database().documentTemplate.count({ where: { tenantId: a.tenantId, kind: "ASSET_FINANCE" } })).toBe(2)
    expect(await database().documentTemplate.count({ where: { tenantId: b.tenantId, kind: "ASSET_FINANCE" } })).toBe(0)
    expect(await database().auditLog.count({ where: { tenantId: a.tenantId, action: "ASSET_TEMPLATE_ADOPTED" } })).toBe(2)
    const isa = await tpl(a, "af.isa.commercial")
    expect(await database().documentTemplateVersion.count({ where: { templateId: isa.id } })).toBe(1)
    // An edit, then adopting again: the lender's wording is untouched.
    expect((await createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", "ALPHA") })).ok).toBe(true)
    expect(await adoptStarter(actor(a, a.adminA), "af.isa")).toEqual({ ok: true, value: { created: [], existing: ["af.isa.commercial", "af.isa.cpa"] } })
    expect((await latest(database(), isa.id)).content).toBe(canonicalContent(edited("af.isa.commercial", "ALPHA")))
    expect((await templateRoutes(a.host).adopt("af.unknown")).status).toBe(422)
  })

  it("the database keeps lender wording immutable, hashed, authored by the lender's own staff and never deleted", async () => {
    const isa = await tpl(a, "af.isa.commercial")
    const v = await latest(database(), isa.id)
    const row = { templateId: isa.id, version: 99, bodyHtml: "", tokensUsed: [], content: v.content, contentSha256: v.contentSha256, createdById: a.adminA }
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: v.id }, data: { content: canonicalContent(starterContent(parseTemplateKey("af.isa.commercial")!)) } })))
      .toMatch(/version is immutable: edit by creating a new draft/)
    expect(await sqlError(() => database().documentTemplateVersion.create({ data: { ...row, contentSha256: "0".repeat(64) } }))).toMatch(/contentSha256 is the SHA-256/)
    expect(await sqlError(() => database().documentTemplateVersion.create({ data: { ...row, status: "ACTIVE" } }))).toMatch(/created as an unapproved draft/)
    expect(await sqlError(() => database().documentTemplateVersion.create({ data: { ...row, createdById: b.adminA } }))).toMatch(/active user of its lender/)
    expect(await sqlError(() => database().documentTemplateVersion.delete({ where: { id: v.id } }))).toMatch(/version is never deleted/)
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: isa.id }, data: { assetVariant: "cpa", key: "af.isa.cpa" } }))).toMatch(/Unique constraint|lender, kind and document are fixed/)
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: isa.id }, data: { name: "Renamed" , requiresApproval: false } }))).toMatch(/DocumentTemplate_asset_finance_shape/)
    expect(await sqlError(() => database().documentTemplate.delete({ where: { id: isa.id } }))).toMatch(/template is never deleted/)
  })

  it("the routes refuse edits of the template itself, invalid wording, and another lender's template", async () => {
    const isa = await tpl(a, "af.isa.commercial")
    const routes = templateRoutes(a.host)
    signIn(a, a.adminA, "LOAN_ADMIN")
    for (let i = 0; i < 2; i++) {
      expect((await routes.patch(isa.id, { name: "x" })).status).toBe(403)
      expect((await routes.remove(isa.id)).status).toBe(403)
    }
    const bad = await routes.saveDraft(isa.id, { content: { ...edited("af.isa.commercial", "BAD"), additionalTerms: [{ heading: "Fees", text: "An administration fee of R 500 is payable on signature." }] } })
    expect(bad.status).toBe(422)
    expect((await bad.json()).problems.map((p: { message: string }) => p.message).join()).toMatch(/Amounts of money come only from the deal/)
    expect((await routes.saveDraft(isa.id, { content: "not json" })).status).toBe(422)
    expect((await routes.preview(isa.id, { content: { ...edited("af.isa.commercial", "BAD"), clauses: {} } })).status).toBe(422)
    const preview = await routes.preview(isa.id, { versionId: (await latest(database(), isa.id)).id })
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-type")).toBe("application/pdf")
    expect(preview.headers.get("x-template-content-sha256")).toBe((await latest(database(), isa.id)).contentSha256)
    // Lender B cannot read, preview, draft, approve or publish lender A's template.
    signIn(b, b.adminA, "LOAN_ADMIN", true)
    const other = templateRoutes(b.host)
    const v = await latest(database(), isa.id)
    expect((await other.preview(isa.id, { versionId: v.id })).status).toBe(404)
    expect((await other.saveDraft(isa.id, { content: edited("af.isa.commercial", "B") })).status).toBe(404)
    expect((await other.approve(isa.id, v.id, legalInput(v.contentSha256))).status).toBe(404)
    expect((await other.publish(isa.id, v.id)).status).toBe(404)
    // A generic letter cannot be generated from asset-finance legal wording.
    await expect(generateDocument({ tenantId: a.tenantId, templateKey: "af.isa.commercial", clientId: a.director }))
      .rejects.toBeInstanceOf(TemplateUnavailableError)
  })

  it("approval binds the exact content, is never the author's, needs TOTP, and a legal one needs a SUPER_ADMIN and its sign-off", async () => {
    const isa = await tpl(a, "af.isa.commercial")
    const v = await latest(database(), isa.id)
    const legal = await legalActor(database(), a.tenantId)
    const routes = templateRoutes(a.host)
    signIn(a, a.adminB, "LOAN_ADMIN")
    expect((await routes.approve(isa.id, v.id, legalInput(v.contentSha256))).status).toBe(403) // no TOTP
    signIn(a, a.adminB, "LOAN_ADMIN", true)
    const notSuper = await routes.approve(isa.id, v.id, legalInput(v.contentSha256))
    expect(notSuper.status).toBe(403)
    expect((await notSuper.json()).error).toMatch(/SUPER_ADMIN/)
    expect(await approveVersion(actor(a, a.adminA), isa.id, v.id, legalInput(v.contentSha256))).toMatchObject({ ok: false, status: 409, error: "Cannot approve your own draft" })
    const older = await database().documentTemplateVersion.findFirstOrThrow({ where: { templateId: isa.id, version: 1 } })
    expect(await approveVersion(legal, isa.id, v.id, legalInput(older.contentSha256))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/changed since you previewed/) })
    expect(await approveVersion(legal, isa.id, v.id, { ...legalInput(v.contentSha256), attestation: false })).toMatchObject({ ok: false, status: 422 })
    expect(await approveVersion(legal, isa.id, v.id, { ...legalInput(v.contentSha256), legalSignOff: false })).toMatchObject({ ok: false, status: 422, error: expect.stringMatching(/signed off this exact version/) })
    expect(await approveVersion(legal, isa.id, v.id, { ...legalInput(v.contentSha256), legalSignOffReference: "x" })).toMatchObject({ ok: false, status: 422, error: expect.stringMatching(/written sign-off/) })
    // Database: the author, a wrong hash, a demo basis on a real lender, another lender's user, a LOAN_ADMIN's legal approval.
    const raw = (data: object) => database().documentTemplateVersion.update({ where: { id: v.id }, data })
    const base = {
      approvedAt: new Date(), approvedContentSha256: v.contentSha256, approvalBasis: "LENDER_LEGAL" as const, legalSignOffReference: "TEST FIXTURE ONLY",
      approvedSystemSha256: await systemFingerprint("af.isa.commercial"),
    }
    expect(await sqlError(() => raw({ ...base, approvedById: legal.userId, approvedSystemSha256: null }))).toMatch(/binds the fingerprint of the protected wording/)
    expect(await sqlError(() => raw({ ...base, approvedById: a.adminA }))).toMatch(/author of an asset-finance template version cannot approve it/)
    expect(await sqlError(() => raw({ ...base, approvedById: legal.userId, approvedContentSha256: "1".repeat(64) }))).toMatch(/approval binds the exact content hash/)
    expect(await sqlError(() => raw({ ...base, approvedById: legal.userId, approvalBasis: "SYNTHETIC_DEMO", legalSignOffReference: null }))).toMatch(/demo lender's approval is SYNTHETIC_DEMO/)
    expect(await sqlError(() => raw({ ...base, approvedById: b.adminB }))).toMatch(/approver is an active user/)
    expect(await sqlError(() => raw({ ...base, approvedById: a.adminB }))).toMatch(/legal approval is recorded by a SUPER_ADMIN/)
    // Through the route, as the SUPER_ADMIN with TOTP; then a second approval at once is refused.
    signIn(a, legal.userId, "SUPER_ADMIN", true)
    const [ok, again] = await Promise.all([routes.approve(isa.id, v.id, legalInput(v.contentSha256)), approveVersion(legal, isa.id, v.id, legalInput(v.contentSha256))])
    expect([ok.status === 200, again.ok].filter(Boolean)).toHaveLength(1)
    const approved = await latest(database(), isa.id)
    expect(approved).toMatchObject({ approvalBasis: "LENDER_LEGAL", approvedById: legal.userId, approvedContentSha256: approved.contentSha256, approvedSystemSha256: base.approvedSystemSha256 })
    expect(await sqlError(() => raw({ approvedById: a.adminA }))).toMatch(/approval is recorded once and never changed/)
    const audit = await database().auditLog.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "DOCUMENT_TEMPLATE_VERSION_APPROVED", entityId: v.id } })
    expect(audit.newValue).toMatchObject({ approvedContentSha256: v.contentSha256, approvalBasis: "LENDER_LEGAL", attestation: true, legalSignOff: true, approverRole: "SUPER_ADMIN" })
  })

  it("a demo lender's approval is synthetic, never a legal one, and stops issuing if the lender stops being a demo lender", async () => {
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: true } })
    await adoptStarter(actor(b, b.adminA), "af.resolution")
    const res = await tpl(b, "af.resolution.standard")
    const v = await latest(database(), res.id)
    expect(await approveVersion(actor(b, b.adminB), res.id, v.id, legalInput(v.contentSha256))).toEqual({ ok: true, value: { approvalBasis: "SYNTHETIC_DEMO" } })
    expect((await latest(database(), res.id)).legalSignOffReference).toBeNull()
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: false } })
    expect(await publishVersion(actor(b, b.adminA), res.id, v.id)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/approval basis/) })
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: v.id }, data: { status: "ACTIVE", activatedById: b.adminA, activatedAt: new Date() } })))
      .toMatch(/approval basis no longer matches the lender/)
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: true } })
    expect(await publishVersion(actor(b, b.adminA), res.id, v.id)).toMatchObject({ ok: true })
    expect((await selectIssuableTemplate(appDb(), b.tenantId, "af.resolution.standard")).approvalBasis).toBe("SYNTHETIC_DEMO")
    await database().tenantConfig.update({ where: { tenantId: b.tenantId }, data: { isDemoLender: false } })
    await expect(selectIssuableTemplate(appDb(), b.tenantId, "af.resolution.standard")).rejects.toThrow(/was approved as a synthetic demo/)
    // Only a fresh legal approval issues again.
    await draftApprovePublish(database(), b.tenantId, res.id, starterContent(parseTemplateKey("af.resolution.standard")!), b.adminA)
    expect((await selectIssuableTemplate(appDb(), b.tenantId, "af.resolution.standard")).approvalBasis).toBe("LENDER_LEGAL")
  })

  it("publication: approved drafts only, never by the approver, with TOTP, one ACTIVE version, no republishing an archived one", async () => {
    const isa = await tpl(a, "af.isa.commercial")
    const routes = templateRoutes(a.host)
    const v1 = await database().documentTemplateVersion.findFirstOrThrow({ where: { templateId: isa.id, version: 1 } })
    expect(await publishVersion(actor(a, a.adminA), isa.id, v1.id)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/requires approval/) })
    const v2 = await latest(database(), isa.id)
    signIn(a, v2.approvedById!, "SUPER_ADMIN", true)
    expect((await (await routes.publish(isa.id, v2.id)).json()).error).toMatch(/approver cannot also publish/)
    signIn(a, a.adminA, "LOAN_ADMIN")
    expect((await routes.publish(isa.id, v2.id)).status).toBe(403) // no TOTP
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: v1.id }, data: { status: "ACTIVE", activatedById: a.adminA, activatedAt: new Date() } })))
      .toMatch(/approved before it is published/)
    signIn(a, a.adminA, "LOAN_ADMIN", true)
    expect((await routes.publish(isa.id, v2.id)).status).toBe(200)
    expect((await tpl(a, "af.isa.commercial")).currentVersionId).toBe(v2.id)
    const v3 = await draftApprovePublish(database(), a.tenantId, isa.id, edited("af.isa.commercial", "ALPHA-THREE"), a.adminA)
    expect((await database().documentTemplateVersion.findUniqueOrThrow({ where: { id: v2.id } })).status).toBe("ARCHIVED")
    expect(await publishVersion(actor(a, a.adminA), isa.id, v2.id)).toMatchObject({ ok: false, error: expect.stringMatching(/archived version is not published again/) })
    expect(await publishVersion(actor(a, a.adminA), isa.id, v3)).toMatchObject({ ok: false, error: expect.stringMatching(/already published/) })
    expect(await sqlError(() => database().documentTemplateVersion.update({ where: { id: v2.id }, data: { status: "ACTIVE" } }))).toMatch(/DRAFT to ACTIVE to ARCHIVED only/)
    expect(await sqlError(() => database().documentTemplate.update({ where: { id: isa.id }, data: { currentVersionId: v2.id } }))).toMatch(/points at its one ACTIVE version/)
    expect(await database().documentTemplateVersion.count({ where: { templateId: isa.id, status: "ACTIVE" } })).toBe(1)
  })

  it("two publications at once leave exactly one ACTIVE version the template points at; concurrent drafts get distinct numbers", async () => {
    const isa = await tpl(a, "af.isa.commercial")
    const legal = await legalActor(database(), a.tenantId)
    const drafts: string[] = []
    for (const marker of ["RACE-ONE", "RACE-TWO"]) {
      const d = await createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", marker) })
      if (!d.ok) throw new Error(d.error)
      expect(await approveVersion(legal, isa.id, d.value.id, legalInput(d.value.contentSha256))).toMatchObject({ ok: true })
      drafts.push(d.value.id)
    }
    const results = await Promise.all(drafts.map((id) => publishVersion(actor(a, a.adminA), isa.id, id)))
    expect(results.every((r) => r.ok)).toBe(true)
    const active = await database().documentTemplateVersion.findMany({ where: { templateId: isa.id, status: "ACTIVE" } })
    expect(active).toHaveLength(1)
    expect((await tpl(a, "af.isa.commercial")).currentVersionId).toBe(active[0].id)
    expect(await database().documentTemplateVersion.count({ where: { id: { in: drafts }, status: "ARCHIVED" } })).toBe(1)
    const saves = await Promise.all([1, 2, 3].map(() => createDraftVersion(actor(a, a.adminA), isa.id, { content: edited("af.isa.commercial", "SAVE") })))
    expect(new Set(saves.map((s) => (s.ok ? s.value.version : -1))).size).toBe(3)
  })

  it("the demo backfill publishes every variant with a synthetic approval, marked as seeded, idempotently, and refuses a real lender", async () => {
    await expect(ensureSyntheticTemplates(a.tenantId, { adminOne: { id: a.adminA, email: "a@x.invalid" }, adminTwo: { id: a.adminB, email: "b@x.invalid" } }))
      .rejects.toThrow(/only for a synthetic demo lender/)
    c = await createDealFixture(database(), tc, { templates: false })
    await database().tenantConfig.update({ where: { tenantId: c.tenantId }, data: { isDemoLender: true } })
    const staff = { adminOne: { id: c.adminA, email: "a@x.invalid" }, adminTwo: { id: c.adminB, email: "b@x.invalid" } }
    await ensureSyntheticTemplates(c.tenantId, staff)
    await ensureSyntheticTemplates(c.tenantId, staff)
    const versions = await database().documentTemplateVersion.findMany({ where: { template: { tenantId: c.tenantId } } })
    expect(versions).toHaveLength(11)
    expect(versions.every((v) => v.status === "ACTIVE" && v.approvalBasis === "SYNTHETIC_DEMO" && v.approvedById === c.adminB && v.activatedById === c.adminA)).toBe(true)
    const audits = await database().auditLog.findMany({ where: { tenantId: c.tenantId, action: { in: ["DOCUMENT_TEMPLATE_VERSION_APPROVED", "DOCUMENT_TEMPLATE_VERSION_PUBLISHED", "ASSET_TEMPLATE_ADOPTED"] } } })
    expect(audits).toHaveLength(33)
    expect(audits.every((row) => (row.newValue as { via?: string }).via === "seed")).toBe(true)
  })

  it("the demo backfill approves again a version whose approval lapsed with a protected wording change, keeping the lender's wording", async () => {
    const staff = { adminOne: { id: c.adminA, email: "a@x.invalid" }, adminTwo: { id: c.adminB, email: "b@x.invalid" } }
    const key = "af.lease.operating.commercial"
    const res = await templateOf(database(), c.tenantId, key)
    // The lender's own wording, as if approved before CredaFlow changed the protected wording (written past the store).
    const text = canonicalContent(edited(key, "DEMO"))
    const stale = await database().documentTemplateVersion.create({ data: {
      templateId: res.id, version: 2, bodyHtml: "", tokensUsed: [], content: text, contentSha256: contentSha256(text), createdById: c.adminA,
    } })
    await database().documentTemplateVersion.update({ where: { id: stale.id }, data: {
      approvedById: c.adminB, approvedAt: new Date(), approvalBasis: "SYNTHETIC_DEMO", approvedContentSha256: stale.contentSha256, approvedSystemSha256: "0".repeat(64),
    } })
    await database().$transaction([
      database().documentTemplateVersion.updateMany({ where: { templateId: res.id, status: "ACTIVE" }, data: { status: "ARCHIVED" } }),
      database().documentTemplateVersion.update({ where: { id: stale.id }, data: { status: "ACTIVE", activatedById: c.adminA, activatedAt: new Date() } }),
      database().documentTemplate.update({ where: { id: res.id }, data: { currentVersionId: stale.id } }),
    ])
    await expect(selectIssuableTemplate(appDb(), c.tenantId, key)).rejects.toThrow(/changed after your approval/)
    await ensureSyntheticTemplates(c.tenantId, staff)
    await ensureSyntheticTemplates(c.tenantId, staff)
    const now = await latest(database(), res.id)
    expect(now).toMatchObject({ version: 3, status: "ACTIVE", content: text, approvalBasis: "SYNTHETIC_DEMO", approvedSystemSha256: await systemFingerprint(key) })
    expect((await selectIssuableTemplate(appDb(), c.tenantId, key)).approvalBasis).toBe("SYNTHETIC_DEMO")
    // Only the lapsed variant got a new version.
    expect(await database().documentTemplateVersion.count({ where: { template: { tenantId: c.tenantId } } })).toBe(13)
  })
})
