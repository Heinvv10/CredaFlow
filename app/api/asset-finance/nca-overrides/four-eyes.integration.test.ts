/**
 * Real-Postgres proof of the NCA regime override's four-eyes rule (DESIGN D5,
 * goal §4.3): NCA → NON_NCA needs a second, different approver with
 * decide_asset_finance, and a move back to NCA applies at once.
 *
 * Only the session is stubbed. The role guard, the tenant resolver (by host),
 * the session-to-tenant binding, the feature flag, the routes, the audit
 * writer, the regime trigger and CHECK NcaRegimeOverride_four_eyes are real.
 *
 *   RUN_ASSET_FINANCE_OVERRIDE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/asset-finance/nca-overrides/four-eyes.integration.test.ts
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

const RUN = process.env.RUN_ASSET_FINANCE_OVERRIDE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null

const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_af_4eyes_${t}`
const host = `af-4eyes-${t}.override-it.test`
const ids = { adminA: "", adminB: "", officerC: "", applicationId: "", overrideId: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_OVERRIDE_IT=1 is required")
  return db
}

const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@override-it.test`, role, tenantId } }
}
const request = (path: string, body: unknown) => new NextRequest(`http://${host}${path}`, {
  method: "POST",
  headers: { host, "content-type": "application/json" },
  body: JSON.stringify(body),
})
const postClassify = (applicationId: string) =>
  classify(request(`/api/asset-finance/applications/${applicationId}/classify`, {}), {
    params: Promise.resolve({ id: applicationId }),
  })
const postOverride = (applicationId: string, body: unknown) =>
  requestOverride(request(`/api/asset-finance/applications/${applicationId}/nca-overrides`, body), {
    params: Promise.resolve({ id: applicationId }),
  })
const postDecision = (overrideId: string, body: unknown) =>
  decideOverride(request(`/api/asset-finance/nca-overrides/${overrideId}/decide`, body), {
    params: Promise.resolve({ overrideId }),
  })

const regime = async () =>
  (await database().loanApplication.findUniqueOrThrow({ where: { id: ids.applicationId } })).ncaRegime
const overrideRow = (id: string) => database().ncaRegimeOverride.findUniqueOrThrow({ where: { id } })
const auditActions = async () =>
  (await database().auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } })).map((r) => r.action)

suite.sequential("NCA regime override four-eyes (real Postgres, real routes)", () => {
  beforeAll(async () => {
    const prisma = database()
    await prisma.tenant.create({ data: { id: tenantId, slug: `af-4eyes-${t}`, name: "Override IT", domain: host } })
    await prisma.tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
    const user = (label: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") =>
      prisma.user.create({ data: { tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role } })
    ids.adminA = (await user("admin-a", "LOAN_ADMIN")).id
    ids.adminB = (await user("admin-b", "LOAN_ADMIN")).id
    ids.officerC = (await user("officer-c", "CREDIT_OFFICER")).id
    const product = await prisma.loanProduct.create({
      data: {
        tenantId, code: `AF-${t}`, name: "Synthetic plant finance", productType: "PERSONAL",
        minAmount: 100, maxAmount: 1_000_000_000, minTermDays: 30, maxTermDays: 3650,
        interestRatePm: 1.0, interestModel: "DAILY_ACCRUAL",
      },
    })
    // No financial statements on file: the classifier must say NCA (FINANCIALS_UNPROVEN).
    const entity = await prisma.businessEntity.create({
      data: { tenantId, type: "COMPANY", legalName: "TEST Synthetic Plant Hire (Pty) Ltd", registrationNumber: `2099/${t.slice(0, 6)}/07` },
    })
    const application = await prisma.loanApplication.create({
      data: {
        tenantId, reference: `AF-4EYES-${t}`, entityId: entity.id, productId: product.id,
        appliedAmount: 150_000_000, appliedTermDays: 1825,
      },
    })
    ids.applicationId = application.id
  })

  afterAll(async () => {
    if (!db) return
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.ncaRegimeOverride.deleteMany({ where: { tenantId } })
    await db.loanApplication.deleteMany({ where: { tenantId } })
    await db.businessEntity.deleteMany({ where: { tenantId } })
    await db.loanProduct.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("classifies the unevidenced company application NCA (FINANCIALS_UNPROVEN) and snapshots it", async () => {
    signIn(ids.officerC, "CREDIT_OFFICER")
    const response = await postClassify(ids.applicationId)
    expect(response.status).toBe(200)
    expect((await response.json()).classification).toMatchObject({ regime: "NCA", rule: "FINANCIALS_UNPROVEN" })
    const row = await database().loanApplication.findUniqueOrThrow({ where: { id: ids.applicationId } })
    expect(row).toMatchObject({ ncaRegime: "NCA", ncaClassificationRule: "FINANCIALS_UNPROVEN", ncaClassifiedById: ids.officerC })
    expect(row.ncaClassifiedAt).toBeInstanceOf(Date)
  })

  it("(a) A requests NCA → NON_NCA: a PENDING override, regime unchanged; a second request is refused", async () => {
    signIn(ids.adminA, "LOAN_ADMIN")
    const response = await postOverride(ids.applicationId, { toRegime: "NON_NCA", reason: "Audited AFS show R4m turnover, filed late" })
    expect(response.status).toBe(201)
    const created = await response.json()
    ids.overrideId = created.id
    expect(await overrideRow(ids.overrideId)).toMatchObject({
      status: "PENDING", fromRegime: "NCA", toRegime: "NON_NCA", requestedById: ids.adminA, decidedById: null,
    })
    expect(await regime()).toBe("NCA")

    const again = await postOverride(ids.applicationId, { toRegime: "NON_NCA", reason: "Second request for the same change" })
    expect(again.status).toBe(409)
    expect(await database().ncaRegimeOverride.count({ where: { tenantId } })).toBe(1)
  })

  it("(b) A deciding their own request is refused 403 and audited; the regime stays NCA", async () => {
    signIn(ids.adminA, "LOAN_ADMIN")
    const response = await postDecision(ids.overrideId, { decision: "APPROVE", note: "Approving my own request" })
    expect(response.status).toBe(403)
    expect(await regime()).toBe("NCA")
    expect(await overrideRow(ids.overrideId)).toMatchObject({ status: "PENDING", decidedById: null })
    const refusal = await database().auditLog.findFirstOrThrow({
      where: { tenantId, action: "NCA_OVERRIDE_DECISION_REFUSED", userId: ids.adminA },
    })
    expect(refusal).toMatchObject({ entityId: ids.overrideId, newValue: { refused: true, reason: "four_eyes_self_decision", httpStatus: 403 } })
  })

  it("(c) credit officer C deciding is refused 403; the regime stays NCA", async () => {
    signIn(ids.officerC, "CREDIT_OFFICER")
    const response = await postDecision(ids.overrideId, { decision: "APPROVE", note: "Officer approving" })
    expect(response.status).toBe(403)
    expect(await regime()).toBe("NCA")
    expect(await overrideRow(ids.overrideId)).toMatchObject({ status: "PENDING", decidedById: null })
    expect(await database().auditLog.count({
      where: { tenantId, action: "NCA_OVERRIDE_DECISION_REFUSED", userId: ids.officerC },
    })).toBe(1)
  })

  it("(d) B approves: the application becomes NON_NCA and the trail holds every step", async () => {
    signIn(ids.adminB, "LOAN_ADMIN")
    const response = await postDecision(ids.overrideId, { decision: "APPROVE", note: "AFS checked against the CIPC record" })
    expect(response.status).toBe(200)
    expect(await regime()).toBe("NON_NCA")
    expect(await overrideRow(ids.overrideId)).toMatchObject({
      status: "APPROVED", requestedById: ids.adminA, decidedById: ids.adminB, decisionNote: "AFS checked against the CIPC record",
    })
    const decided = await database().auditLog.findFirstOrThrow({
      where: { tenantId, action: "NCA_OVERRIDE_DECIDED", entityId: ids.overrideId },
    })
    expect(decided).toMatchObject({ userId: ids.adminB, oldValue: { ncaRegime: "NCA" }, newValue: { status: "APPROVED", ncaRegime: "NON_NCA" } })
    expect(await auditActions()).toEqual([
      "NCA_CLASSIFIED",
      "NCA_OVERRIDE_REQUESTED",
      "NCA_OVERRIDE_DECISION_REFUSED",
      "NCA_OVERRIDE_DECISION_REFUSED",
      "NCA_OVERRIDE_DECIDED",
    ])
  })

  it("(e) a NON_NCA → NCA override by one user applies immediately", async () => {
    signIn(ids.adminA, "LOAN_ADMIN")
    const response = await postOverride(ids.applicationId, { toRegime: "NCA", reason: "Turnover figure was group, not entity" })
    expect(response.status).toBe(201)
    const created = await response.json()
    expect(await overrideRow(created.id)).toMatchObject({
      status: "APPROVED", fromRegime: "NON_NCA", toRegime: "NCA", requestedById: ids.adminA, decidedById: ids.adminA,
    })
    expect(await regime()).toBe("NCA")
    // One transaction, so one createdAt: compare as a set.
    const rows = await database().auditLog.findMany({ where: { tenantId, entityId: created.id } })
    expect(rows.map((r) => r.action).sort()).toEqual(["NCA_OVERRIDE_DECIDED", "NCA_OVERRIDE_REQUESTED"])
  })
})
