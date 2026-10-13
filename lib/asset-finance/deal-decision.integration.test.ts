/**
 * Real-Postgres proof of asset-finance origination (goal §4.7, decisions
 * 2a.3 and 2a.6): create → submit → classify → four-eyes regime override →
 * credit memo → decision with mandatory reasons; an NCA deal is refused and
 * audited.
 *
 * Only the session is stubbed. Routes, role guard, tenant resolution (by
 * host), feature flag, classifier, audit writer, regime trigger, CHECKs and
 * the (dry-run) Experian bureau path are real.
 *
 *   RUN_ASSET_FINANCE_DEAL_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/deal-decision.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addMonthsClamped } from "./dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, dealRoutes, type DealFixture } from "./deal.integration-fixture"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEAL_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealFixture
const deals = { refused: "", approved: "", declined: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_DEAL_IT=1 is required")
  return db
}
const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@deal-it.test`, role, tenantId: fx.tenantId } }
}
const routes = () => dealRoutes(fx.host)
const firstDueDate = addMonthsClamped(sastCalendarDate(new Date()), 2)
const structure = (assetId: string) => ({
  assetId, depositCents: 17_250_000, balloonCents: 0, firstDueDate,
  preset: { kind: "MONTHLY", periods: 60 }, rateBasis: "PRIME", rateMargin: "0.0100",
})
const dealRow = (id: string) => database().assetFinanceDeal.findUniqueOrThrow({ where: { id }, include: { application: true } })
const audits = (entityId: string, action: string) => database().auditLog.findMany({ where: { tenantId: fx.tenantId, entityId, action } })
const REASONS = ["DSCR 1.8 on audited AFS", "Directors' bureau records clean"]

suite.sequential("asset-finance deal decision (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t)
  })

  afterAll(async () => {
    if (!db) return
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("creates a deal: a DRAFT entity application for the financed amount, the deal DRAFT, audited", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const preview = await routes().preview(structure(fx.assets[0]))
    expect(preview.status).toBe(200)
    const solved = await preview.json()
    expect(solved.financedAmountCents).toBe(172_500_000 - 17_250_000)

    const created = await routes().create({ ...structure(fx.assets[0]), entityId: fx.unevidenced, supplierId: fx.supplier, productId: fx.product })
    expect(created.status).toBe(201)
    const deal = await created.json()
    deals.refused = deal.id
    const row = await dealRow(deal.id)
    expect(row).toMatchObject({ status: "DRAFT", baseInstalmentCents: solved.baseInstalmentCents, structurePreset: "MONTHLY" })
    expect(row.application).toMatchObject({
      status: "DRAFT", entityId: fx.unevidenced, clientId: null, appliedAmount: 155_250_000, ncaRegime: null,
    })
    expect(row.application.appliedTermDays).toBe(solved.termDays)
    expect(await audits(deal.id, "ASSET_DEAL_CREATED")).toHaveLength(1)

    // The same asset cannot sit on a second open deal.
    const again = await routes().create({ ...structure(fx.assets[0]), entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product })
    expect(again.status).toBe(409)
  })

  it("refuses the unevidenced company's deal at submit: REFUSED_NCA, application DECLINED, audited", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().submit(deals.refused)
    expect(response.status).toBe(200)
    const body = await response.json()
    const reason = "NCA applies (Turnover and asset value not proven by verified financial statements)"
    expect(body).toMatchObject({ refusedNca: true, reason, deal: { status: "REFUSED_NCA" } })
    const row = await dealRow(deals.refused)
    expect(row.status).toBe("REFUSED_NCA")
    expect(row.application).toMatchObject({ status: "DECLINED", ncaRegime: "NCA", decisionReason: reason })
    const [refusal] = await audits(deals.refused, "ASSET_DEAL_REFUSED_NCA")
    expect(refusal).toMatchObject({ userId: fx.officer, newValue: { status: "REFUSED_NCA", rule: "FINANCIALS_UNPROVEN", reason } })
    expect(await database().ncaRegimeOverride.count({ where: { applicationId: row.applicationId } })).toBe(0)
  })

  it("submits the evidenced R2m company's deal: SUBMITTED, awaiting the second approver", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const created = await routes().create({ ...structure(fx.assets[1]), entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product })
    deals.approved = (await created.json()).id
    const response = await routes().submit(deals.approved)
    expect(await response.json()).toMatchObject({ refusedNca: false, awaitingRegimeApproval: true, deal: { status: "SUBMITTED" } })
    const row = await dealRow(deals.approved)
    expect(row.application).toMatchObject({ status: "SUBMITTED", ncaRegime: "NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD" })
    expect(await database().ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: row.applicationId } }))
      .toMatchObject({ status: "PENDING", toRegime: "NON_NCA", requestedById: fx.officer })
  })

  it("runs the consumer bureau check for the director and lists it on the deal", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().bureau(deals.approved)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.results).toEqual([{ clientId: fx.director, role: "DIRECTOR", outcome: "stored" }])
    expect(body.deal.bureau).toEqual([expect.objectContaining({ clientId: fx.director, outcome: "stored", provider: "experian" })])
    const row = await dealRow(deals.approved)
    expect(await database().creditBureauCheck.count({ where: { applicationId: row.applicationId, clientId: fx.director } })).toBe(1)
    expect(await audits(deals.approved, "ASSET_DEAL_BUREAU_CHECKED")).toHaveLength(1)
  })

  it("APPROVE while the override is pending is 409 and audited; nothing changes", async () => {
    signIn(fx.adminA, "LOAN_ADMIN")
    const response = await routes().decide(deals.approved, { decision: "APPROVE", reasons: REASONS })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe("The NON_NCA override awaits a second approver")
    expect((await dealRow(deals.approved)).status).toBe("SUBMITTED")
    expect(await audits(deals.approved, "ASSET_DEAL_DECISION_REFUSED")).toEqual([
      expect.objectContaining({ newValue: expect.objectContaining({ reason: "awaiting_regime_approval" }) }),
    ])
  })

  it("a second LOAN_ADMIN approves the override; APPROVE then needs the credit memo and reasons", async () => {
    const row = await dealRow(deals.approved)
    const override = await database().ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: row.applicationId } })
    signIn(fx.adminB, "LOAN_ADMIN")
    expect((await routes().decideOverride(override.id, { decision: "APPROVE", note: "AFS agree with CIPC" })).status).toBe(200)
    expect((await dealRow(deals.approved)).application.ncaRegime).toBe("NON_NCA")

    signIn(fx.adminA, "LOAN_ADMIN")
    const noMemo = await routes().decide(deals.approved, { decision: "APPROVE", reasons: REASONS })
    expect(noMemo.status).toBe(409)
    expect((await noMemo.json()).error).toMatch(/credit memo/)
    expect((await routes().decide(deals.approved, { decision: "APPROVE", reasons: [] })).status).toBe(400)
    expect((await routes().decide(deals.approved, { decision: "APPROVE", reasons: ["ok  "] })).status).toBe(400)
  })

  it("records the credit memo with DSCR and gearing from the deal's own schedule", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().financials(deals.approved, {
      periodEnd: "2026-02-28", turnoverCents: 200_000_000, ebitdaCents: 60_000_000, totalAssetsCents: 200_000_000,
      totalLiabilitiesCents: 50_000_000, existingDebtServiceCents: 10_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 1,
    })
    expect(response.status).toBe(200)
    const { deal } = await response.json()
    // Independent working: 60 equal monthly rows (no balloon) → annual = 12 × the mean row total.
    const rows: Array<{ totalCents: number }> = deal.schedule.result.rows
    const annual = Math.round((rows.reduce((s, r) => s + r.totalCents, 0) * 12) / rows.length)
    expect(deal.financials).toMatchObject({ gearing: "0.2500", dscr: (60_000_000 / (10_000_000 + annual)).toFixed(4) })
    const stored = await database().entityFinancials.findUniqueOrThrow({ where: { dealId: deals.approved } })
    expect(stored.turnoverCents).toBe(BigInt(200_000_000))
    expect(stored.gearing?.toFixed(4)).toBe("0.2500")
  })

  it("APPROVE with reasons: application APPROVED NON_NCA (EFT, approver), deal APPROVED, audited with the reasons", async () => {
    signIn(fx.adminA, "LOAN_ADMIN")
    const response = await routes().decide(deals.approved, { decision: "APPROVE", reasons: REASONS })
    expect(response.status).toBe(200)
    const row = await dealRow(deals.approved)
    expect(row).toMatchObject({ status: "APPROVED", decision: "APPROVE", decisionReasons: REASONS, decidedById: fx.adminA })
    expect(row.application).toMatchObject({
      status: "APPROVED", ncaRegime: "NON_NCA", repaymentMethod: "EFT", approvedById: fx.adminA, approvedAmount: 155_250_000,
    })
    expect(row.application.approvedAt).toBeInstanceOf(Date)
    const [decided] = await audits(deals.approved, "ASSET_DEAL_DECIDED")
    expect(decided).toMatchObject({ userId: fx.adminA, newValue: { decision: "APPROVE", reasons: REASONS, applicationStatus: "APPROVED" } })
  })

  it("DECLINE needs reasons too; with them the application and deal are DECLINED and audited", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const created = await routes().create({ ...structure(fx.assets[2]), entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product })
    deals.declined = (await created.json()).id
    await routes().submit(deals.declined)

    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().decide(deals.declined, { decision: "DECLINE" })).status).toBe(400)
    expect((await routes().decide(deals.declined, { decision: "DECLINE", reasons: ["   "] })).status).toBe(400)
    expect((await dealRow(deals.declined)).status).toBe("SUBMITTED")

    const reasons = ["Gearing above policy for plant hire"]
    expect((await routes().decide(deals.declined, { decision: "DECLINE", reasons })).status).toBe(200)
    const row = await dealRow(deals.declined)
    expect(row).toMatchObject({ status: "DECLINED", decision: "DECLINE", decisionReasons: reasons })
    expect(row.application).toMatchObject({ status: "DECLINED", decisionReason: reasons[0] })
    expect(await audits(deals.declined, "ASSET_DEAL_DECIDED")).toEqual([
      expect.objectContaining({ newValue: expect.objectContaining({ decision: "DECLINE", reasons }) }),
    ])
  })
})
