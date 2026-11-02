/**
 * The database's own guard on a variable-rate approval (real Postgres, the real decide route, no session_replication_role): a rate that
 * did not come from an APPROVED reference value, the version's margin, or the live rule that priced it is refused even when the code is
 * made to freeze it. Pricing is forged by wrapping the pricing modules; the guard is all that stands. And the SQL fingerprint hashes what
 * the TypeScript one hashes. Mocked as ls-booking.integration.test.ts mocks.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ls-variable-forged.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const forge = vi.hoisted(() => ({ reference: null as null | { rate: number; effectiveDate: string }, baseShift: 0, ruleShift: 0 }))
vi.mock("@/lib/product-engine/variable-rate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/product-engine/variable-rate")>()
  return {
    ...actual,
    referenceOn: async (...args: Parameters<typeof actual.referenceOn>) => forge.reference ?? actual.referenceOn(...args),
    rateFromReference: (...args: Parameters<typeof actual.rateFromReference>) => actual.rateFromReference(...args) + forge.baseShift,
  }
})
vi.mock("@/lib/product-engine/pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/product-engine/pricing")>()
  return {
    ...actual,
    resolvePricing: (...args: Parameters<typeof actual.resolvePricing>) => {
      const priced = actual.resolvePricing(...args)
      return priced.ruleId ? { ...priced, ratePm: priced.ratePm + forge.ruleShift } : priced
    },
  }
})
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
import { affordabilityInputFingerprint, type AffordabilityDecisionInputs } from "@/lib/affordability/snapshot"
import { sastCalendarDate } from "@/lib/date/sast"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { AGREEMENT_KEY, KFS_KEY, createTemplate } from "./gate.integration-fixture"
import { lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, seedStack, seedUnderReview, stackOf } from "./ls-stack.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const role = `cf_vf_${t.slice(0, 10)}_it`
const stack = stackOf("LS", t)
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`
const TODAY = sastCalendarDate(new Date())
const daysAgo = (n: number) => sastCalendarDate(new Date(Date.now() - n * 86_400_000))

suite("the database's guard on a variable-rate approval (real Postgres)", () => {
  let fresh: ThrowawayDb
  let app: ReturnType<typeof createAppPrismaClient>
  const db = () => fresh.db
  const { decideForm } = lsFlow(db, stack, holder)
  const maker = { id: stack.officer, email: "maker@test.invalid", role: "LOAN_ADMIN" }
  const checker = { id: stack.senior, email: "checker@test.invalid", role: "ADMIN", totpVerified: true }
  const approved = (kind: string, title: string, payload: unknown) => runWithTenant(stack.tenant, async () => {
    const draft = await createDraft({ tenantId: stack.tenant, actor: maker, kind, title, payload })
    await submit({ tenantId: stack.tenant, actor: maker, id: draft.id })
    await approve({ tenantId: stack.tenant, actor: checker, id: draft.id })
  })
  const rate = async (effectiveDate: string, value: string, status: "APPROVED" | "PENDING") => {
    const row = await db().referenceRate.create({ data: { tenantId: stack.tenant, basis: "PRIME", effectiveDate: dbDate(effectiveDate), rate: value, requestedById: stack.officer } })
    if (status === "APPROVED") await db().referenceRate.update({ where: { id: row.id }, data: { status: "APPROVED", decidedById: stack.senior, decidedAt: new Date() } })
  }
  /** Decide on a fresh application: 200 approved, anything else refused with the application still under review. */
  async function decide(name: string) {
    const id = `${name}-${t}`
    const { statement } = await seedUnderReview(db(), stack, id, { nca: false })
    holder.files.set(statement.path, statement.bytes)
    await clearOpenFlags(db(), stack, id)
    await db().applicationPricingInput.create({ data: { applicationId: id, tenantId: stack.tenant, channel: "BRANCH" } })
    const res = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    return { status: res.status, state: (await db().loanApplication.findUniqueOrThrow({ where: { id } })).status }
  }
  const refused = { status: 500, state: "UNDER_REVIEW" }

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "VFRG", isDemoLender: true })
    await createTemplate(db(), stack.tenant, KFS_KEY, BODY("Key facts statement"))
    await createTemplate(db(), stack.tenant, AGREEMENT_KEY, BODY("Loan agreement"))
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
    holder.app = app
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
    await rate(daysAgo(30), "0.09", "APPROVED")
    await approved("PRODUCT_VERSION", "Prime-linked", {
      productId: stack.product, effectiveFrom: TODAY, reason: "Prime-linked launch",
      config: {
        minAmountCents: 100_000, maxAmountCents: 5_000_000, minTermDays: 28, maxTermDays: 365, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMaxCents: 0,
        monthlyServiceFeeCents: 0, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 }, variableRate: { basis: "PRIME", marginPa: 0.03 },
        collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null },
      },
    })
  }, 300_000)
  afterEach(() => {
    forge.reference = null
    forge.baseShift = 0
    forge.ruleShift = 0
  })
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

  it("hashes in SQL what TypeScript hashes, the variable rate and the balloon share included", async () => {
    const inputs = {
      monthlyIncomeCents: 2_000_000, monthlyExpensesCents: 800_000, applicationDebtCents: 0, clientDebtCents: 0, declaredDebtCents: 0, bureauObligationsCents: 0, proposedInstalmentCents: 1, principalCents: 500_000,
      termDays: 30, productId: "p", interestRatePm: 0.01, interestModel: "REDUCING_BALANCE", initiationFeePct: 0, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 0, initiationFeePayment: "DEFERRED", ndiBufferPct: 110,
    } as unknown as AffordabilityDecisionInputs
    const sql = async (value: AffordabilityDecisionInputs) => (await db().$queryRaw<Array<{ sha: string }>>`SELECT "affordabilityInputSha256"(${JSON.stringify(value)}::jsonb) AS sha`)[0]!.sha
    const balloon = { frequency: "WEEKLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, instalments: 4 } as const
    for (const value of [
      inputs,
      { ...inputs, variableRate: { basis: "PRIME", marginPa: 0.03, referenceRate: 0.09, referenceEffectiveDate: "2026-10-01" } },
      { ...inputs, repayment: { ...balloon, balloonPct: 0.3 } },
      { ...inputs, repayment: { ...balloon, balloonPct: 0.25 } },
    ] as AffordabilityDecisionInputs[]) expect(await sql(value)).toBe(affordabilityInputFingerprint(value))
  })

  it("approves what an approved reference and the version's margin give", async () => {
    expect(await decide("honest")).toEqual({ status: 200, state: "APPROVED" })
  })

  it("refuses a rate priced off a reference value nobody approved", async () => {
    await rate(daysAgo(2), "0.11", "PENDING")
    forge.reference = { rate: 0.11, effectiveDate: daysAgo(2) }
    expect(await decide("pending")).toEqual(refused)
  })

  it("refuses a base rate that is not the reference plus the version's margin", async () => {
    forge.baseShift = 0.001
    expect(await decide("margin")).toEqual(refused)
  })

  it("refuses a rule-priced rate that is not what the live rule gives", async () => {
    await approved("PRODUCT_PRICING_RULE", "Discount", { action: "CREATE", rule: { productId: stack.product, name: "Payroll discount", segment: null, channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: TODAY, validTo: null, priority: 0, rate: { mode: "ADD", value: -0.001 }, initiationFeePct: null } })
    expect(await decide("rule-honest")).toEqual({ status: 200, state: "APPROVED" })
    forge.ruleShift = 0.0005
    expect(await decide("rule-forged")).toEqual(refused)
  })
})
