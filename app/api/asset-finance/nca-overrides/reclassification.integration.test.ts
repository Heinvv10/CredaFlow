/**
 * Real-Postgres proof that an NCA regime approval is bound to the application
 * it approved, through the real routes (DESIGN D5):
 *   - an approval is refused as stale, and recorded REJECTED, once the
 *     application's amount moved after the request, or once it was
 *     re-classified (even to the same rule: the request named the earlier run);
 *   - re-classifying a NON_NCA application to the same rule writes nothing;
 *     to a different result it goes back to NCA first (the snapshot is frozen
 *     while NON_NCA), and a NON_NCA result needs a fresh approval;
 *   - an open classifier request is rejected as superseded, in the classifying
 *     user's name, when a re-run says NCA or no longer matches it.
 *
 * Only the session is stubbed; the routes, the audit writer and the triggers
 * are real.
 *
 *   RUN_ASSET_FINANCE_OVERRIDE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/asset-finance/nca-overrides/reclassification.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { POST as classify } from "../applications/[id]/classify/route"
import { POST as requestOverride } from "../applications/[id]/nca-overrides/route"
import { POST as decideOverride } from "./[overrideId]/decide/route"
import { STALE_OVERRIDE_NOTE } from "@/lib/asset-finance/classification"
import { SUPERSEDED_OVERRIDE_NOTE } from "@/lib/asset-finance/override-snapshot"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_ASSET_FINANCE_OVERRIDE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null

const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_af_reclass_${t}`
const host = `af-reclass-${t}.override-it.test`
const ids = { adminA: "", adminB: "", officerC: "", entityId: "", manualApp: "", classifiedApp: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_OVERRIDE_IT=1 is required")
  return db
}

const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@override-it.test`, role, tenantId } }
}
const request = (path: string, body: unknown) => new NextRequest(`http://${host}${path}`, {
  method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify(body),
})
const postClassify = (id: string) =>
  classify(request(`/api/asset-finance/applications/${id}/classify`, {}), { params: Promise.resolve({ id }) })
const postOverride = (id: string, body: unknown) =>
  requestOverride(request(`/api/asset-finance/applications/${id}/nca-overrides`, body), { params: Promise.resolve({ id }) })
const postDecision = (overrideId: string, body: unknown) =>
  decideOverride(request(`/api/asset-finance/nca-overrides/${overrideId}/decide`, body), { params: Promise.resolve({ overrideId }) })

const application = (id: string) => database().loanApplication.findUniqueOrThrow({ where: { id } })
const overrideRow = (id: string) => database().ncaRegimeOverride.findUniqueOrThrow({ where: { id } })
const setEvidence = (evidence: string[]) =>
  database().businessEntity.update({ where: { id: ids.entityId }, data: { financialsEvidenceIds: evidence } })

suite.sequential("NCA approvals bound to the application (real Postgres, real routes)", () => {
  beforeAll(async () => {
    const prisma = database()
    await prisma.tenant.create({ data: { id: tenantId, slug: `af-reclass-${t}`, name: "Reclassification IT", domain: host } })
    await prisma.tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
    const user = async (label: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") =>
      (await prisma.user.create({ data: { tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role } })).id
    ids.adminA = await user("admin-a", "LOAN_ADMIN")
    ids.adminB = await user("admin-b", "LOAN_ADMIN")
    ids.officerC = await user("officer-c", "CREDIT_OFFICER")
    const product = await prisma.loanProduct.create({
      data: {
        tenantId, code: `AFR-${t}`, name: "Synthetic plant finance", productType: "PERSONAL", minAmount: 100,
        maxAmount: 1_000_000_000, minTermDays: 30, maxTermDays: 3650, interestRatePm: 1.0, interestModel: "DAILY_ACCRUAL",
      },
    })
    // Audited R2m turnover: the classifier says NON_NCA (JURISTIC_OVER_THRESHOLD).
    ids.entityId = (await prisma.businessEntity.create({
      data: {
        tenantId, type: "COMPANY", legalName: "TEST Synthetic Earthmoving (Pty) Ltd",
        registrationNumber: `2099/${t.slice(0, 6)}/09`, annualTurnover: 200_000_000, financialsEvidenceIds: [`afs-${t}`],
      },
    })).id
    const app = async (suffix: string) => (await prisma.loanApplication.create({
      data: {
        tenantId, reference: `AF-RECLASS-${suffix}-${t}`, entityId: ids.entityId, productId: product.id,
        appliedAmount: 150_000_000, appliedTermDays: 1825,
      },
    })).id
    ids.manualApp = await app("M")
    ids.classifiedApp = await app("C")
  })

  afterAll(async () => {
    if (!db) return
    await purgeAuditRowsForTest(db, { tenantId })
    // Overrides are never deleted; only this test's rows go, with triggers off.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.ncaRegimeOverride.deleteMany({ where: { tenantId } }),
      db.loanApplication.deleteMany({ where: { tenantId } }),
    ])
    await db.businessEntity.deleteMany({ where: { tenantId } })
    await db.loanProduct.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("rejects an approval as stale once the amount moved after the request; the regime stays NCA", async () => {
    await setEvidence([])
    signIn(ids.officerC, "CREDIT_OFFICER")
    expect((await postClassify(ids.manualApp)).status).toBe(200) // NCA, FINANCIALS_UNPROVEN
    signIn(ids.adminA, "LOAN_ADMIN")
    const requested = await postOverride(ids.manualApp, { toRegime: "NON_NCA", reason: "Audited AFS show R4m turnover, filed late" })
    expect(requested.status).toBe(201)
    const overrideId = (await requested.json()).id as string
    expect(await overrideRow(overrideId)).toMatchObject({
      source: "MANUAL", approvedEntityId: ids.entityId, approvedAppliedAmount: 150_000_000, approvedClassificationRule: "FINANCIALS_UNPROVEN",
    })

    // Still NCA and open: the amount may change, and does.
    await database().loanApplication.update({ where: { id: ids.manualApp }, data: { appliedAmount: 90_000_000 } })
    signIn(ids.adminB, "LOAN_ADMIN")
    const decided = await postDecision(overrideId, { decision: "APPROVE", note: "AFS checked against the CIPC record" })
    expect(decided.status).toBe(409)
    expect(await overrideRow(overrideId)).toMatchObject({ status: "REJECTED", decisionNote: STALE_OVERRIDE_NOTE, appliedAt: null })
    expect((await application(ids.manualApp)).ncaRegime).toBe("NCA")
    await setEvidence([`afs-${t}`])
  })

  it("rejects an approval as stale once a re-classification replaced the one requested on, even on the same rule", async () => {
    await setEvidence([])
    signIn(ids.officerC, "CREDIT_OFFICER")
    expect((await postClassify(ids.manualApp)).status).toBe(200) // NCA, FINANCIALS_UNPROVEN
    signIn(ids.adminA, "LOAN_ADMIN")
    const requested = await postOverride(ids.manualApp, { toRegime: "NON_NCA", reason: "Audited AFS show R4m turnover, filed late" })
    expect(requested.status).toBe(201)
    const overrideId = (await requested.json()).id as string
    const before = await application(ids.manualApp)
    expect((await overrideRow(overrideId)).approvedClassifiedAt).toEqual(before.ncaClassifiedAt)

    // The same facts, the same NCA rule: a manual request stays open for its decider.
    signIn(ids.officerC, "CREDIT_OFFICER")
    const rerun = await (await postClassify(ids.manualApp)).json()
    expect(rerun).toMatchObject({ classification: { rule: "FINANCIALS_UNPROVEN" }, supersededOverrideId: null })
    expect((await application(ids.manualApp)).ncaClassifiedAt).not.toEqual(before.ncaClassifiedAt)

    signIn(ids.adminB, "LOAN_ADMIN")
    const decided = await postDecision(overrideId, { decision: "APPROVE", note: "AFS checked against the CIPC record" })
    expect(decided.status).toBe(409)
    expect(await overrideRow(overrideId)).toMatchObject({ status: "REJECTED", decisionNote: STALE_OVERRIDE_NOTE, appliedAt: null })
    expect((await application(ids.manualApp)).ncaRegime).toBe("NCA")
    await setEvidence([`afs-${t}`])
  })

  it("re-classifies an approved NON_NCA application: same rule writes nothing; NCA goes back; NON_NCA needs a fresh approval", async () => {
    signIn(ids.officerC, "CREDIT_OFFICER")
    const first = await (await postClassify(ids.classifiedApp)).json()
    signIn(ids.adminB, "LOAN_ADMIN")
    expect((await postDecision(first.pendingOverrideId, { decision: "APPROVE", note: "AFS agree with CIPC" })).status).toBe(200)
    const approved = await application(ids.classifiedApp)
    expect(approved).toMatchObject({ ncaRegime: "NON_NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD" })

    signIn(ids.officerC, "CREDIT_OFFICER")
    const same = await postClassify(ids.classifiedApp)
    expect(await same.json()).toMatchObject({ regime: "NON_NCA", unchanged: true, pendingOverrideId: null })
    expect((await application(ids.classifiedApp)).ncaClassifiedAt).toEqual(approved.ncaClassifiedAt)

    await setEvidence([])
    const nca = await postClassify(ids.classifiedApp)
    expect(nca.status).toBe(200)
    expect(await application(ids.classifiedApp)).toMatchObject({ ncaRegime: "NCA", ncaClassificationRule: "FINANCIALS_UNPROVEN" })

    await setEvidence([`afs-${t}`])
    const again = await (await postClassify(ids.classifiedApp)).json()
    expect(again).toMatchObject({ regime: "NCA", classification: { regime: "NON_NCA" } })
    expect(await overrideRow(again.pendingOverrideId)).toMatchObject({
      status: "PENDING", source: "CLASSIFIER", requestedById: ids.officerC, approvedClassificationRule: "JURISTIC_OVER_THRESHOLD",
    })
    expect(again.pendingOverrideId).not.toBe(first.pendingOverrideId)
  })

  it("rejects the classifier's open request as superseded when it no longer matches, or the result is NCA", async () => {
    const open = await database().ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: ids.classifiedApp, status: "PENDING" } })
    // The amount moves while NCA: the open request describes another application now.
    await database().loanApplication.update({ where: { id: ids.classifiedApp }, data: { appliedAmount: 160_000_000 } })
    signIn(ids.officerC, "CREDIT_OFFICER")
    const moved = await (await postClassify(ids.classifiedApp)).json()
    expect(moved).toMatchObject({ supersededOverrideId: open.id })
    expect(await overrideRow(open.id)).toMatchObject({ status: "REJECTED", decisionNote: SUPERSEDED_OVERRIDE_NOTE, decidedById: ids.officerC })
    expect(await overrideRow(moved.pendingOverrideId)).toMatchObject({ status: "PENDING", approvedAppliedAmount: 160_000_000 })

    // The classifying user rejects their own request: four-eyes binds approvals only.
    await setEvidence([])
    const nca = await (await postClassify(ids.classifiedApp)).json()
    expect(nca).toMatchObject({ regime: "NCA", pendingOverrideId: null, supersededOverrideId: moved.pendingOverrideId })
    expect(await overrideRow(moved.pendingOverrideId)).toMatchObject({
      status: "REJECTED", requestedById: ids.officerC, decidedById: ids.officerC, decisionNote: SUPERSEDED_OVERRIDE_NOTE,
    })
    expect(await database().ncaRegimeOverride.count({ where: { applicationId: ids.classifiedApp, status: "PENDING" } })).toBe(0)
  })
})
