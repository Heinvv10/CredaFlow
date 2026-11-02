/**
 * A balloon on a variable rate through the real key-facts payout (real Postgres, real routes, no session_replication_role): approved on the
 * version, signed, paid out, and what the payout wrote then carries the repricing. Mocked as ls-booking.integration.test.ts mocks.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ls-variable-booking.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", files: new Map<string, Buffer>() }))
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, {
    get(_t, key) {
      if (!holder.app) throw new Error("the RLS-bound app client is created in beforeAll")
      const value: unknown = Reflect.get(holder.app, key)
      return typeof value === "function" ? value.bind(holder.app) : value
    },
  })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({
    user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) =>
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho booking IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))
vi.mock("@/lib/storage", () => ({
  saveFile: async (buffer: Buffer) => { const path = `/mem/${holder.files.size}.pdf`; holder.files.set(path, buffer); return { storagePath: path, fileSize: buffer.length } },
  readFile: async (path: string) => { const b = holder.files.get(path); if (!b) throw new Error("missing"); return b },
  deleteFile: async (path: string) => { holder.files.delete(path) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => Buffer.from(`%PDF-synthetic ${html} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => ({ legalName: "Demo Basotho Lending (Pty) Ltd", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }) }))

import { dbDate } from "@/lib/asset-finance/dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { createAppPrismaClient } from "@/lib/prisma"
import { repriceTenantLoans } from "@/lib/product-engine/reprice-batch"
import { runWithTenant } from "@/lib/tenant-scope"
import { AGREEMENT_KEY, KFS_KEY, createTemplate } from "./gate.integration-fixture"
import { lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, seedStack, seedUnderReview, stackOf } from "./ls-stack.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const role = `cf_vb_${t.slice(0, 10)}_it`
const stack = stackOf("LS", t)
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`
const TODAY = sastCalendarDate(new Date())

suite("a balloon on a variable rate, paid out through the key-facts route (real Postgres)", () => {
  let fresh: ThrowawayDb
  let app: ReturnType<typeof createAppPrismaClient>
  const db = () => fresh.db
  const { decideForm, disburseAs, attestKyc, issueAndSign, verifyAccount } = lsFlow(db, stack, holder)

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "VBAL", isDemoLender: true })
    await createTemplate(db(), stack.tenant, KFS_KEY, BODY("Key facts statement"))
    await createTemplate(db(), stack.tenant, AGREEMENT_KEY, BODY("Loan agreement"))
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
    holder.app = app
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }, 300_000)
  afterAll(async () => {
    vi.unstubAllEnvs()
    holder.app = null
    await app?.$disconnect()
    await fresh?.db.$executeRawUnsafe(`DROP OWNED BY ${role}`).catch(() => undefined)
    await fresh?.drop()
    const admin = new PrismaClient()
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
    await admin.$disconnect()
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
  }, 60_000)

  const approvedRate = async (effectiveDate: string, rate: string) => {
    const row = await db().referenceRate.create({ data: { tenantId: stack.tenant, basis: "PRIME", effectiveDate: dbDate(effectiveDate), rate, requestedById: stack.officer } })
    await db().referenceRate.update({ where: { id: row.id }, data: { status: "APPROVED", decidedById: stack.senior, decidedAt: new Date() } })
  }

  it("books the balloon and the rate, and the first repricing runs on what the payout wrote", async () => {
    await approvedRate(sastCalendarDate(new Date(Date.now() - 30 * 86_400_000)), "0.09")
    const config = {
      minAmountCents: 100_000, maxAmountCents: 5_000_000, minTermDays: 28, maxTermDays: 365, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 0,
      repayment: { frequency: "WEEKLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, balloonPct: 0.3 }, variableRate: { basis: "PRIME", marginPa: 0.03 }, collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null },
    }
    await runWithTenant(stack.tenant, async () => {
      const maker = { id: stack.officer, email: "maker@test.invalid", role: "LOAN_ADMIN" }
      const draft = await createDraft({ tenantId: stack.tenant, actor: maker, kind: "PRODUCT_VERSION", title: "Prime-linked balloon", payload: { productId: stack.product, effectiveFrom: TODAY, reason: "Prime-linked balloon launch", config } })
      await submit({ tenantId: stack.tenant, actor: maker, id: draft.id })
      await approve({ tenantId: stack.tenant, actor: { id: stack.senior, email: "checker@test.invalid", role: "ADMIN", totpVerified: true }, id: draft.id })
    })

    const id = `bal-${t}`
    const { statement } = await seedUnderReview(db(), stack, id, { nca: false })
    holder.files.set(statement.path, statement.bytes)
    await clearOpenFlags(db(), stack, id)
    await db().applicationPricingInput.create({ data: { applicationId: id, tenantId: stack.tenant, channel: "BRANCH" } })
    const decided = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    expect(decided.status, JSON.stringify(await decided.clone().json())).toBe(200)
    await attestKyc(id)
    await issueAndSign(id)
    expect((await verifyAccount(stack.officer, id)).status).toBe(200)
    const paid = await disburseAs(stack.disburser, id)
    expect(paid.status, JSON.stringify(await paid.clone().json())).toBe(200)

    const application = await db().loanApplication.findUniqueOrThrow({ where: { id }, include: { loan: { include: { terms: true, repaymentSchedule: { orderBy: { installmentNo: "asc" } } } } } })
    const loan = application.loan!
    const balloon = Math.round(application.appliedAmount * 0.3)
    const rate = Math.round((0.12 / 12) * 1e8) / 1e8
    expect(loan.interestRatePm).toBe(rate)
    expect(loan.terms).toHaveLength(1)
    expect(loan.terms[0]).toMatchObject({ sequence: 1, structure: "BALLOON", frequency: "WEEKLY", balloonCents: balloon, rateBasis: "PRIME", rateMarginPa: 0.03, referenceRate: 0.09, interestRatePm: rate })
    expect(loan.repaymentSchedule.reduce((a, r) => a + r.principalDue, 0)).toBe(application.appliedAmount)
    expect(loan.repaymentSchedule.at(-1)!.principalDue).toBeGreaterThan(balloon)
    expect(Math.max(...loan.repaymentSchedule.slice(0, -1).map((r) => r.principalDue))).toBeLessThan(balloon)

    await approvedRate(TODAY, "0.15")
    expect(await runWithTenant(stack.tenant, () => repriceTenantLoans(stack.tenant, TODAY))).toMatchObject({ repriced: 1, failed: 0 })
    const after = await db().loan.findUniqueOrThrow({ where: { id: loan.id }, include: { terms: { orderBy: { sequence: "asc" } }, repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    expect(after.terms[1]).toMatchObject({ sequence: 2, balloonCents: balloon, rateMarginPa: 0.03, referenceRate: 0.15 })
    expect(after.totalInterest).toBeGreaterThan(loan.totalInterest)
    expect(after.repaymentSchedule.reduce((a, r) => a + r.principalDue, 0)).toBe(application.appliedAmount)
    expect(after.repaymentSchedule.at(-1)!.principalDue).toBeGreaterThan(balloon)
    expect(after.totalInterest).toBe(after.repaymentSchedule.reduce((a, r) => a + r.interestDue, 0))
  }, 120_000)

  it("a pricing rule on a variable rate is approved, and the loan keeps the margin after the rule", async () => {
    await runWithTenant(stack.tenant, async () => {
      const maker = { id: stack.officer, email: "maker@test.invalid", role: "LOAN_ADMIN" }
      const rule = { productId: stack.product, name: "Payroll discount", segment: null, channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: TODAY, validTo: null, priority: 0, rate: { mode: "ADD", value: -0.001 }, initiationFeePct: null }
      const draft = await createDraft({ tenantId: stack.tenant, actor: maker, kind: "PRODUCT_PRICING_RULE", title: "Discount", payload: { action: "CREATE", rule } })
      await submit({ tenantId: stack.tenant, actor: maker, id: draft.id })
      await approve({ tenantId: stack.tenant, actor: { id: stack.senior, email: "checker@test.invalid", role: "ADMIN", totpVerified: true }, id: draft.id })
    })
    const id = `rule-${t}`
    const { statement } = await seedUnderReview(db(), stack, id, { nca: false })
    holder.files.set(statement.path, statement.bytes)
    await clearOpenFlags(db(), stack, id)
    await db().applicationPricingInput.create({ data: { applicationId: id, tenantId: stack.tenant, channel: "BRANCH" } })
    const decided = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    expect(decided.status, JSON.stringify(await decided.clone().json())).toBe(200)
    const inputs = (await db().loanApplication.findUniqueOrThrow({ where: { id } })).affordabilityResult as { approval: { inputs: { interestRatePm: number; variableRate: { marginPa: number; referenceRate: number } } } }
    expect(inputs.approval.inputs.interestRatePm).toBeCloseTo(0.014, 8)
    expect(inputs.approval.inputs.variableRate).toMatchObject({ referenceRate: 0.15 })
    expect(inputs.approval.inputs.variableRate.marginPa).toBeCloseTo(0.018, 7)
  }, 120_000)
})
