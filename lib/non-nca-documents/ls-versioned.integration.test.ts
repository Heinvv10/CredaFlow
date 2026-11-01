/**
 * A key-facts loan on a product under the product engine, on real Postgres through the real routes with no session_replication_role: the
 * version and the pricing rule go through the maker-checker service, the approval is the real decide, and the database guards pass it.
 * Mocked as ls-end-to-end.integration.test.ts mocks.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ls-versioned.integration.test.ts
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
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho versioned IT", domain: null, status: "ACTIVE" })),
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

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { PRODUCT_VERSION_KIND } from "@/lib/product-engine/change-handlers"
import { STRUCTURED_SCHEDULE_CHANNEL } from "@/lib/product-engine/channels"
import { PRICING_RULE_KIND } from "@/lib/product-engine/pricing"
import { runWithTenant } from "@/lib/tenant-scope"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate } from "./gate.integration-fixture"
import { lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, seedStack, seedUnderReview, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_lsver_${t}`
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const { attestKyc, decideForm, disburseAs, issueAndSign, verifyAccount } = lsFlow(db, stack, holder)
const actor = (userId: string) => ({ id: userId, email: `${userId}@test.invalid`, role: "ADMIN" as never, tenantId: stack.tenant, totpVerified: true })
/** A change through the maker-checker service: drafted and submitted by the officer, approved by the senior. */
const change = (kind: string, title: string, payload: Record<string, unknown>) => runWithTenant(stack.tenant, async () => {
  const draft = await createDraft({ tenantId: stack.tenant, actor: actor(stack.officer), kind, title, payload })
  await submit({ tenantId: stack.tenant, actor: actor(stack.officer), id: draft.id })
  await approve({ tenantId: stack.tenant, actor: actor(stack.senior), id: draft.id })
})
async function structuredApplication(id: string) {
  const { statement } = await seedUnderReview(db(), stack, id, { nca: false })
  holder.files.set(statement.path, statement.bytes)
  await db().applicationPricingInput.create({ data: { applicationId: id, tenantId: stack.tenant, channel: STRUCTURED_SCHEDULE_CHANNEL } })
  await clearOpenFlags(db(), stack, id)
}
async function approveSignConfirm(id: string) {
  const decided = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
  expect(decided.status, JSON.stringify(await decided.clone().json())).toBe(200)
  await attestKyc(id)
  await issueAndSign(id)
  expect((await verifyAccount(stack.confirmer, id)).status).toBe(200)
}

suite("a key-facts loan on a versioned product (real Postgres, real routes, no bypass)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "VER", isDemoLender: true })
    await createTemplate(db(), stack.tenant, OFFER_KEY, "<p>Offer letter {{quote.principal}}</p>")
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

  it("a versioned, weekly amortising loan is approved and booked with its version, rule, structure and deferred interest", async () => {
    const id = `week-${t}`
    const config = {
      minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 1, maxTermDays: 180, interestRatePm: 0.05, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 6_900, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 }, collateral: [],
      eligibility: { minAge: 18, maxAge: 65, minMonthlyIncomeCents: null, minEmploymentMonths: null },
    }
    await change(PRODUCT_VERSION_KIND, "Weekly", { productId: stack.product, effectiveFrom: new Date().toISOString().slice(0, 10), reason: "Synthetic weekly structure", config })
    await structuredApplication(id)
    await approveSignConfirm(id)

    const res = await disburseAs(stack.disburser, id)
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)

    const application = await db().loanApplication.findUniqueOrThrow({ where: { id }, include: { loan: { include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } } } })
    const loan = application.loan!
    const version = await db().productVersion.findFirstOrThrow({ where: { productId: stack.product } })
    const terms = await db().loanTerms.findFirstOrThrow({ where: { loanId: loan.id } })
    expect(terms).toMatchObject({ sequence: 1, productVersionId: version.id, frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", baseRatePm: 0.05, interestRatePm: 0.05, deferredInterest: 0 })
    expect(terms.instalments).toBe(loan.repaymentSchedule.length)
    expect(loan.repaymentSchedule.length).toBeGreaterThan(1)
    expect(loan.repaymentSchedule.map((r) => r.dueDate.toISOString())).toEqual((application.affordabilityResult as { approval: { calculator: { schedule: { dueDate: string }[] } } }).approval.calculator.schedule.map((s) => s.dueDate))
    const created = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: loan.id, action: "LOAN_CREATED" } })
    expect(created.newValue).toMatchObject({ productVersionId: version.id, productVersion: version.version })
  })

  it("a pricing rule that prices away from the product row is approved and booked at its rate: decide used to answer 500", async () => {
    const id = `ruled-${t}`
    await change(PRICING_RULE_KIND, "Staff rate", { action: "CREATE", rule: { productId: stack.product, name: "Synthetic staff rate", segment: null, channel: STRUCTURED_SCHEDULE_CHANNEL, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: new Date().toISOString().slice(0, 10), validTo: null, priority: 10, rate: { mode: "SET", value: 0.04 }, initiationFeePct: null } })
    await structuredApplication(id)
    await approveSignConfirm(id)
    const res = await disburseAs(stack.disburser, id)
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    const loan = await db().loan.findFirstOrThrow({ where: { applicationId: id } })
    expect(loan.interestRatePm).toBe(0.04)
    const rule = await db().productPricingRule.findFirstOrThrow({ where: { productId: stack.product } })
    expect(await db().loanTerms.findFirstOrThrow({ where: { loanId: loan.id } })).toMatchObject({ baseRatePm: 0.05, interestRatePm: 0.04, pricingRuleId: rule.id, pricingRuleName: "Synthetic staff rate" })
  })
})
