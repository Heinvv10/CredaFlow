/**
 * The database's own check of a rule-priced approval, in both regimes (lib/compliance/countersign-after-mandate-migration.test.ts reads the
 * patch; this runs it). Each test forges the APPROVED write with valid fingerprints, as a writer past decide could, and rolls it back.
 * Mocked as ls-end-to-end.integration.test.ts mocks.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/rule-priced-guard.integration.test.ts
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
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Rule guard IT", domain: null, status: "ACTIVE" })),
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
import { affordabilityDecisionFingerprint, affordabilityInputFingerprint } from "@/lib/affordability/snapshot"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, PRODUCT, seedStack, seedUnderReview, stackOf, type StackJurisdiction } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

for (const jurisdiction of ["ZA", "LS"] satisfies StackJurisdiction[]) {
  const t = randomUUID().replaceAll("-", "").slice(0, 10)
  const stack = stackOf(jurisdiction, t)
  const other = stackOf(jurisdiction, `${t}b`)
  const role = `cf_ruleg_${t}`
  let fresh: ThrowawayDb
  let app: ReturnType<typeof createAppPrismaClient> | undefined
  const db = () => fresh.db
  const { decideForm } = lsFlow(db, stack, holder)
  // Setup only: rule and version rows in states the maker-checker service will not make (expired, over the ceiling). The writes under test run with the triggers on.
  const behindTriggers = (fn: (tx: Tx) => Promise<unknown>) => db().$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica"); await fn(tx) })
  const rule = (id: string, over: object = {}, tenantId = stack.tenant, productId: string | null = stack.product) => behindTriggers((tx) => tx.productPricingRule.create({
    data: { id, tenantId, productId, name: `Rule ${id}`, validFrom: new Date("2020-01-01"), rateMode: "SET", rateValue: 0.04, changeRequestId: `cr-${id}`, ...over } as never,
  }))
  const id = `rg-${t}`
  let saved: Awaited<ReturnType<PrismaClient["loanApplication"]["findUniqueOrThrow"]>>

  /** The APPROVED write decide makes, with `mutate` applied to the approval and its fingerprints recomputed: a forged install. Rolled back whatever the answer. */
  const install = async (mutate: (inputs: Record<string, unknown>) => void = () => undefined): Promise<string> => {
    const store = JSON.parse(JSON.stringify(saved.affordabilityResult)) as { approval: Record<string, unknown> & { inputs: Record<string, unknown>; debts: { application: never; client: never } } }
    const a = store.approval
    mutate(a.inputs)
    a.inputFingerprint = affordabilityInputFingerprint(a.inputs as never)
    a.decisionFingerprint = affordabilityDecisionFingerprint({ ...a, applicationDebts: a.debts.application, clientDebts: a.debts.client } as never)
    const current = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    const columns = ["approvedAmount", "approvedTermDays", "approvedById", "approvedAt", "repaymentMethod", "netDisposableIncome", "affordabilityNDI", "totalExistingDebt", "riskGrade", "riskScore", "submittedAt"] as const
    const data = Object.fromEntries(columns.map((c) => [c, saved[c]]))
    return db().$transaction(async (tx) => {
      await tx.loanApplication.update({ where: { id }, data: { ...data, approvedRate: a.inputs.interestRatePm, status: "APPROVED", affordabilityResult: { ...(current.affordabilityResult as object), approval: a } as object } as never })
      throw new Error("ROLLBACK")
    }).then(() => "unreachable", (error: Error) => (error.message === "ROLLBACK" ? "accepted" : /validated approval transition/.test(error.message) ? "refused" : error.message))
  }
  const named = (pricingRuleId: string | null, interestRatePm: number) => (inputs: Record<string, unknown>) => {
    inputs.interestRatePm = interestRatePm
    inputs.productVersion = { ...(inputs.productVersion as object), pricingRuleId }
  }

  suite(`a rule-priced approval written directly, ${jurisdiction} (real Postgres, triggers on)`, () => {
    beforeAll(async () => {
      fresh = await createThrowawayDb(jurisdiction === "LS" ? { instance: { jurisdiction: "LS", currency: "LSL" } } : {})
      holder.tenantId = stack.tenant
      await seedStack(db(), stack, { code: "RG", isDemoLender: true })
      await seedStack(db(), other, { code: "RH", isDemoLender: true })
      vi.stubEnv("TENANT_RLS", "on")
      app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
      holder.app = app
      resetActiveJurisdiction()
      resetEnsuredJurisdiction()
      await ensureActiveJurisdiction(app as never)
      await behindTriggers((tx) => tx.productVersion.create({
        data: {
          tenantId: stack.tenant, productId: stack.product, version: 1, effectiveFrom: new Date("2020-01-01"), minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180,
          interestRatePm: PRODUCT.interestRatePm, interestModel: PRODUCT.interestModel, initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: PRODUCT.monthlyServiceFee,
          collateral: [], eligibility: {}, reason: "Synthetic", changeRequestId: `cr-v-${t}`,
        } as never,
      }))
      await rule(`good-${t}`)
      const { statement } = await seedUnderReview(db(), stack, id, { nca: jurisdiction === "ZA" })
      holder.files.set(statement.path, statement.bytes)
      await clearOpenFlags(db(), stack, id)
      const approved = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
      expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200)
      saved = await db().loanApplication.findUniqueOrThrow({ where: { id } })
      expect(saved.approvedRate).toBe(0.04)
      const back = await decideForm(id, { action: "return_to_review", reason: "Synthetic: back to review for the direct writes." })
      expect(back.status).toBe(200)
      await rule(`wide-${t}`, {}, stack.tenant, null)
      await rule(`add-${t}`, { rateMode: "ADD", rateValue: -0.01 })
      await rule(`fee-${t}`, { initiationFeePct: 0.1 })
      await rule(`dear-${t}`, { rateValue: 0.06 })
      await rule(`expired-${t}`, { validTo: new Date("2021-01-01") })
      await rule(`future-${t}`, { validFrom: new Date("2099-01-01") })
      await rule(`retired-${t}`, { retiredAt: new Date(), retiredByRequestId: `crr-${t}` })
      await db().loanProduct.create({ data: { id: `${stack.product}-o`, tenantId: stack.tenant, code: `O-${t}`, name: "Other", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, ...PRODUCT } })
      await rule(`product-${t}`, {}, stack.tenant, `${stack.product}-o`)
      await rule(`tenant-${t}`, {}, other.tenant, other.product)
      await rule(`foreign-${t}`, {}, other.tenant, null)
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

    it("accepts what a live rule gives: its SET value, its ADD value on the base, a rule for every product", async () => {
      expect(await install()).toBe("accepted")
      expect(await install(named(`add-${t}`, 0.04))).toBe("accepted")
      expect(await install(named(`wide-${t}`, 0.04))).toBe("accepted")
    })

    it("refuses a rate that is not what the named rule gives, or that no rule gives", async () => {
      expect(await install((inputs) => { inputs.interestRatePm = 0.5 })).toBe("refused")
      expect(await install(named(`add-${t}`, 0.045))).toBe("refused")
      expect(await install(named(null, 0.03))).toBe("refused")
      expect(await install((inputs) => { inputs.interestRatePm = 0.03; delete inputs.productVersion })).toBe("refused")
    })

    it("refuses a rule that is expired, not yet in force, retired, another product's or another tenant's, even at its own value", async () => {
      for (const dead of ["expired", "future", "retired", "product", "tenant", "foreign"]) expect(await install(named(`${dead}-${t}`, 0.04)), dead).toBe("refused")
    })

    it("refuses a base rate off the product row, and a fee no rule gives", async () => {
      expect(await install((inputs) => { inputs.productVersion = { ...(inputs.productVersion as object), baseRatePm: 0.09 } })).toBe("refused")
      expect(await install((inputs) => { inputs.initiationFeePct = 0.9 })).toBe("refused")
      expect(await install((inputs) => { inputs.initiationFeePct = 0.1; inputs.productVersion = { ...(inputs.productVersion as object), pricingRuleId: `fee-${t}` } })).toBe("accepted")
    })

    it(jurisdiction === "ZA" ? "keeps the NCA ceiling binding: a live rule above 5% on a short-term loan is refused" : "has no NCA ceiling: a live rule's value stands", async () => {
      expect(await install(named(`dear-${t}`, 0.06))).toBe(jurisdiction === "ZA" ? "refused" : "accepted")
    })

    it("the ceiling of an unsecured loan is the approved repo rate plus 21% a year, on the basis the rate is billed on, and there is none without one", async () => {
      const allowed = async (ratePm: number, model: string) => {
        const [{ ok }] = await db().$queryRaw<{ ok: boolean }[]>`SELECT public."ncaRatePmAllowed"(${stack.tenant}, 1000000, 365, ${ratePm}::double precision, ${model}) AS ok`
        return ok
      }
      expect(await allowed(0.01, "REDUCING_BALANCE")).toBe(false)
      const repo = await db().referenceRate.create({ data: { tenantId: stack.tenant, basis: "REPO", effectiveDate: new Date("2020-01-01"), rate: 0.07, source: "MANUAL", requestedById: stack.officer } })
      await db().referenceRate.update({ where: { id: repo.id }, data: { status: "APPROVED", decidedById: stack.senior, decidedAt: new Date() } })
      expect(await allowed(0.0233, "REDUCING_BALANCE")).toBe(true)
      expect(await allowed(0.024, "REDUCING_BALANCE")).toBe(false)
      expect(await allowed(0.023, "DAILY_ACCRUAL")).toBe(true)
      expect(await allowed(0.0233, "DAILY_ACCRUAL")).toBe(false)
      expect(await allowed(0.0233, "FLAT")).toBe(false)
    })
  })
}
