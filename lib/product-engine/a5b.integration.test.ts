/**
 * Real-Postgres proof of A5b through the real routes: a product change takes two people, a balloon and a variable rate are
 * what was approved, an approved reference value reprices a loan once and reconciles to the cent, and the product types'
 * facts, groups and deduction list work. Only the session and the instance's jurisdiction are stubbed.
 *
 *   RUN_A5B_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/product-engine/a5b.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: Record<string, unknown> } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: vi.fn(async () => undefined) }))

import { GET as cron } from "@/app/api/cron/loan-rate-reprice/route"
import { POST as act } from "@/app/api/maker-checker/[id]/[action]/route"
import { POST as draftChange } from "@/app/api/maker-checker/route"
import { PUT as setFacts } from "@/app/api/applications/[id]/product-facts/route"
import { GET as deductions } from "@/app/api/products/check-off/deductions/route"
import { PUT as editGroup } from "@/app/api/products/groups/[id]/route"
import { POST as createGroup } from "@/app/api/products/groups/route"
import { DELETE as deactivate, PUT as editProduct } from "@/app/api/products/loan/[id]/route"
import { POST as createProduct } from "@/app/api/products/loan/route"
import { POST as decideRate } from "@/app/api/products/lending-rates/[id]/decide/route"
import { POST as recordRate } from "@/app/api/products/lending-rates/route"
import { dbDate } from "@/lib/asset-finance/dates"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"
import { sastCalendarDate } from "@/lib/date/sast"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { calculateLoan } from "@/lib/loan-calculator"
import { prisma } from "@/lib/prisma"
import { groupEditedBy, productTypeRefusal } from "@/lib/product-types/rules"
import { addPeriods } from "./periods"
import { repriceLoan } from "./reprice-loan"
import type { RepaymentTerms } from "./types"

const suite = process.env.RUN_A5B_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 14)
const tenantId = `t_a5b_${t}`
const host = `a5b-${t}.a5b-it.test`
const staff = { maker: `u_mk_${t}`, maker2: `u_mk2_${t}`, checker: `u_ck_${t}`, officer: `u_of_${t}` }
const roles = { maker: "LOAN_ADMIN", maker2: "LOAN_ADMIN", checker: "ADMIN", officer: "CREDIT_OFFICER" } as const
const day = (offset: number) => sastCalendarDate(new Date(Date.now() + offset * 86_400_000))
const TODAY = day(0)
const cronSecret = "a5b-it-secret-0123456789abcdef"

const signIn = (who: keyof typeof staff) => { session.current = { user: { id: staff[who], email: `${staff[who]}@a5b-it.test`, role: roles[who], tenantId, totpVerified: true } } }
const request = (path: string, method = "GET", body?: unknown) => new NextRequest(`http://${host}${path}`, { method, headers: { host, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const approveRequest = (id: string, who: keyof typeof staff = "checker") => { signIn(who); return act(request(`/api/maker-checker/${id}/approve`, "POST", {}), { params: Promise.resolve({ id, action: "approve" }) }) }
const form = (over: Record<string, unknown> = {}) => ({
  code: `C${randomUUID().slice(0, 8).toUpperCase()}`, name: "Payroll loan", productType: "SALARY_BACKED", minAmount: 1_000, maxAmount: 50_000, minTermDays: 30, maxTermDays: 720, interestRatePm: 2,
  interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 5, initiationFeeMax: 0, monthlyServiceFee: 0, active: true, reason: "A product for the launch", ...over,
})
const created = async (over: Record<string, unknown> = {}) => {
  signIn("maker")
  const body = form(over)
  const response = await createProduct(request("/api/products/loan", "POST", body))
  expect(response.status).toBe(202)
  const { request: change } = await response.json()
  expect((await approveRequest(change.id)).status).toBe(200)
  return db.loanProduct.findFirstOrThrow({ where: { tenantId, code: body.code as string } })
}
const config = (over: Record<string, unknown> = {}) => ({
  minAmountCents: 100_000, maxAmountCents: 5_000_000, minTermDays: 90, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMaxCents: 0,
  monthlyServiceFeeCents: 0, repayment: { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, balloonPct: 0.3 }, variableRate: { basis: "PRIME", marginPa: 0.03 },
  collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null }, ...over,
})
const proposeVersion = async (productId: string, cfg: Record<string, unknown>) => {
  signIn("maker")
  const drafted = await draftChange(request("/api/maker-checker", "POST", { kind: "PRODUCT_VERSION", title: "Variable", payload: { productId, effectiveFrom: TODAY, reason: "Variable rate launch", config: cfg } }))
  expect(drafted.status).toBe(201)
  const { request: change } = await drafted.json()
  const submitted = await act(request(`/api/maker-checker/${change.id}/submit`, "POST", {}), { params: Promise.resolve({ id: change.id, action: "submit" }) })
  return { change, submitted }
}
const approveRate = async (effectiveDate: string, rate: string, basis = "PRIME") => {
  signIn("maker")
  const recorded = await recordRate(request("/api/products/lending-rates", "POST", { basis, effectiveDate, rate }))
  expect(recorded.status).toBe(201)
  const { id } = await recorded.json()
  signIn("checker")
  expect((await decideRate(request(`/api/products/lending-rates/${id}/decide`, "POST", { decision: "APPROVE" }), { params: Promise.resolve({ id }) })).status).toBe(200)
}

/** A loan booked as the disbursement route books one: the engine's schedule, and terms sequence 1 frozen from the approval. */
async function bookLoan(productId: string, versionId: string, opts: { terms: RepaymentTerms; ratePm: number; start: Date; reference: { rate: number; date: string; marginPa: number } }) {
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  const client = await db.client.create({ data: { tenantId, idNumber: `90${n}`, firstName: "Mpho", lastName: `Test${n.slice(0, 4)}`, email: `${n}@client.invalid`, phone: "0820000000" } })
  const calc = calculateLoan({ principal: 1_000_000, termDays: opts.terms.instalments * 30, interestRatePm: opts.ratePm, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, productType: "SALARY_BACKED", initiationFeePayment: "UPFRONT", repayment: opts.terms }, opts.start)
  const application = await db.loanApplication.create({ data: { tenantId, reference: `APP-${n}`, clientId: client.id, productId, appliedAmount: 1_000_000, appliedTermDays: opts.terms.instalments * 30 } })
  const loan = await db.loan.create({
    data: {
      tenantId, reference: `LN-${n}`, applicationId: application.id, clientId: client.id, productId, principal: 1_000_000, totalInterest: calc.totalInterest, initiationFee: 0, totalRepayable: calc.totalRepayable, outstandingPrincipal: 1_000_000,
      contractualTotalInterest: calc.totalInterest, contractualTotalRepayable: calc.totalRepayable, startDate: opts.start, maturityDate: calc.schedule.at(-1)!.dueDate, interestRatePm: opts.ratePm, interestModel: "REDUCING_BALANCE", status: "ACTIVE",
    },
  })
  await db.repaymentSchedule.createMany({ data: calc.schedule.map((r) => ({ tenantId, loanId: loan.id, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue })) })
  await db.loanTerms.create({
    data: {
      tenantId, loanId: loan.id, sequence: 1, productVersionId: versionId, frequency: opts.terms.frequency, structure: opts.terms.structure, graceKind: opts.terms.graceKind, graceInstalments: 0, instalments: opts.terms.instalments,
      balloonCents: opts.terms.balloonPct ? Math.round(1_000_000 * opts.terms.balloonPct) : 0, baseRatePm: opts.ratePm, interestRatePm: opts.ratePm, rateBasis: "LENDER_BASE", rateMarginPa: opts.reference.marginPa, referenceRate: opts.reference.rate, referenceEffectiveDate: dbDate(opts.reference.date),
    },
  })
  return { loanId: loan.id, clientId: client.id, applicationId: application.id, calc }
}
const scheduleOf = (loanId: string) => db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const sweep = async () => cron(new NextRequest(`http://${host}/api/cron/loan-rate-reprice`, { headers: { "x-cron-secret": cronSecret } }))

suite("A5b product types, maker-checker and repricing (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = cronSecret
    await db.tenant.create({ data: { id: tenantId, slug: `a5b-${t}`, name: "A5b IT", domain: host } })
    await db.tenantConfig.create({ data: { tenantId, requireStaffTotp: false } })
    const longAgo = new Date(Date.now() - 400 * 86_400_000)
    for (const key of Object.keys(staff) as Array<keyof typeof staff>) await db.user.create({ data: { id: staff[key], tenantId, email: `${staff[key]}@a5b-it.test`, password: "x", role: roles[key], createdAt: longAgo } })
  })
  beforeEach(() => setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" }))
  afterEach(() => resetActiveJurisdiction())
  afterAll(async () => {
    await purgeAuditRowsForTest(db, { tenantId })
    await db.$disconnect()
    await prisma.$disconnect()
  })

  describe("maker-checker on a product", () => {
    it("a new product does not exist until a second person approves it, and its maker cannot", async () => {
      signIn("maker")
      const body = form()
      const response = await createProduct(request("/api/products/loan", "POST", body))
      expect(response.status).toBe(202)
      const { request: change } = await response.json()
      expect(await db.loanProduct.count({ where: { tenantId, code: body.code as string } })).toBe(0)
      expect((await approveRequest(change.id, "maker")).status).toBe(403)
      expect(await db.loanProduct.count({ where: { tenantId, code: body.code as string } })).toBe(0)
      expect((await approveRequest(change.id, "maker2")).status).toBe(403)
      expect((await approveRequest(change.id)).status).toBe(200)
      const product = await db.loanProduct.findFirstOrThrow({ where: { tenantId, code: body.code as string } })
      expect(product).toMatchObject({ productType: "SALARY_BACKED", maxAmount: 5_000_000, interestRatePm: 0.02 })
      const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId, action: "LOAN_PRODUCT_CREATED", entityId: product.id } })
      expect(audit).toMatchObject({ userId: staff.checker })
      expect(audit.newValue).toMatchObject({ changeRequestId: change.id, makerId: staff.maker })
    })

    it("an edit changes nothing until approved; a deactivation likewise", async () => {
      const product = await created()
      signIn("maker")
      const response = await editProduct(request(`/api/products/loan/${product.id}`, "PUT", form({ code: product.code, name: "Renamed", reason: "A clearer name" })), { params: Promise.resolve({ id: product.id }) })
      expect(response.status).toBe(202)
      const { request: change } = await response.json()
      expect(change.title).toContain("name")
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).name).toBe("Payroll loan")
      expect((await approveRequest(change.id)).status).toBe(200)
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).name).toBe("Renamed")

      signIn("maker")
      const off = await deactivate(request(`/api/products/loan/${product.id}`, "DELETE", { reason: "Withdrawn from sale" }), { params: Promise.resolve({ id: product.id }) })
      expect(off.status).toBe(202)
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).active).toBe(true)
      expect((await approveRequest((await off.json()).request.id)).status).toBe(200)
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).active).toBe(false)
    })

    it("approving over a change that landed first is STALE, not a silent overwrite", async () => {
      const product = await created()
      const propose = async (name: string) => {
        signIn("maker")
        const res = await editProduct(request(`/api/products/loan/${product.id}`, "PUT", form({ code: product.code, name, reason: "A clearer name" })), { params: Promise.resolve({ id: product.id }) })
        return (await res.json()).request.id as string
      }
      const [first, second] = [await propose("First"), await propose("Second")]
      expect((await approveRequest(first)).status).toBe(200)
      const stale = await approveRequest(second)
      expect(stale.status).toBe(409)
      expect((await stale.json()).code).toBe("STALE")
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).name).toBe("First")
    })

    it("a credit officer cannot propose, an empty reason is refused, and a refused proposal leaves no draft", async () => {
      signIn("officer")
      expect((await createProduct(request("/api/products/loan", "POST", form()))).status).toBe(403)
      signIn("maker")
      const body = form({ reason: "" })
      expect((await createProduct(request("/api/products/loan", "POST", body))).status).toBe(422)
      expect(await db.changeRequest.count({ where: { tenantId, kind: "LOAN_PRODUCT", title: { contains: body.code as string } } })).toBe(0)
    })

    it("an NCA lender cannot propose a new type, and its existing products propose as before", async () => {
      resetActiveJurisdiction()
      signIn("maker")
      const refused = await createProduct(request("/api/products/loan", "POST", form({ productType: "SME" })))
      expect(refused.status).toBe(422)
      expect((await refused.json()).invalidFields).toEqual(["productType"])
    })
  })

  describe("a balloon and a variable rate on a version", () => {
    it("is what was approved: columns equal the payload, and the checks hold what the parser holds", async () => {
      const product = await created()
      await approveRate(day(-40), "0.09")
      const { change, submitted } = await proposeVersion(product.id, config())
      expect(submitted.status).toBe(200)
      expect((await approveRequest(change.id)).status).toBe(200)
      const version = await db.productVersion.findFirstOrThrow({ where: { tenantId, productId: product.id } })
      expect(version).toMatchObject({ structure: "BALLOON", balloonPct: 0.3, rateBasis: "PRIME", rateMarginPa: 0.03 })
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).repaymentStructured).toBe(true)
    })

    it("refuses a version whose row is not its payload, and rows the CHECKs do not allow even when a request says so", async () => {
      const product = await created()
      // A request approved in the database's own terms, its payload never through the parser, so the guard passes and only the CHECK answers.
      const approvedWith = async (cfg: Record<string, unknown>) => {
        const id = `cr-${randomUUID()}`
        await db.changeRequest.create({ data: { id, tenantId, kind: "PRODUCT_VERSION", title: "Direct", payload: { productId: product.id, effectiveFrom: TODAY, reason: "Direct write", config: cfg } as never, payloadVersion: 1, makerId: staff.maker } })
        await db.changeRequest.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date() } })
        await db.changeRequest.update({ where: { id }, data: { status: "APPROVED", checkerId: staff.checker, decidedAt: new Date(), appliedAt: new Date() } })
        return id
      }
      const write = async (over: Record<string, unknown>, repayment: Record<string, unknown>, variableRate: Record<string, unknown> | null) => {
        const cfg = config({ repayment, variableRate, ...over })
        const c = cfg as ReturnType<typeof config> & Record<string, never>
        const r = repayment as { frequency: "MONTHLY"; structure: "BALLOON"; graceKind: "NONE"; graceInstalments: number; balloonPct?: number }
        const v = variableRate as { basis: "PRIME"; marginPa: number } | null
        return db.productVersion.create({
          data: {
            tenantId, productId: product.id, version: 1, effectiveFrom: dbDate(TODAY), minAmount: c.minAmountCents, maxAmount: c.maxAmountCents, minTermDays: c.minTermDays, maxTermDays: c.maxTermDays, interestRatePm: c.interestRatePm,
            interestModel: c.interestModel as "FLAT", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, frequency: r.frequency, structure: r.structure, graceKind: r.graceKind, graceInstalments: r.graceInstalments,
            balloonPct: r.balloonPct ?? null, rateBasis: v?.basis ?? null, rateMarginPa: v?.marginPa ?? null, collateral: [], eligibility: c.eligibility, reason: "Direct write", changeRequestId: await approvedWith(cfg),
          },
        }).then(() => "written", (e: unknown) => String(e))
      }
      const balloon = { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0 }
      const amortising = { ...balloon, structure: "AMORTISING" }
      const prime = { basis: "PRIME", marginPa: 0.03 }
      expect(await write({}, balloon, null)).toContain("ProductVersion_balloon")
      expect(await write({}, { ...balloon, balloonPct: 1 }, null)).toContain("ProductVersion_balloon")
      expect(await write({}, { ...amortising, balloonPct: 0.2 }, null)).toContain("ProductVersion_balloon")
      expect(await write({}, { ...balloon, balloonPct: 0.2, graceKind: "FULL", graceInstalments: 1 }, null)).toContain("ProductVersion_balloon")
      expect(await write({ interestModel: "FLAT" }, amortising, prime)).toContain("ProductVersion_variable_rate")
      expect(await write({}, amortising, { basis: "JIBAR", marginPa: 0.03 })).toContain("ProductVersion_variable_rate")
      expect(await write({}, { ...amortising, structure: "BULLET" }, prime)).toContain("ProductVersion_variable_rate")

      // ...and a row that differs from its payload by the new columns alone is refused by the guard.
      const id = await approvedWith(config({ repayment: { ...balloon, balloonPct: 0.2 }, variableRate: null }))
      const base = { tenantId, productId: product.id, version: 1, effectiveFrom: dbDate(TODAY), minAmount: 100_000, maxAmount: 5_000_000, minTermDays: 90, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, frequency: "MONTHLY" as const, structure: "BALLOON" as const, graceKind: "NONE" as const, collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null }, reason: "Direct write", changeRequestId: id }
      expect(await db.productVersion.create({ data: { ...base, balloonPct: 0.25 } }).then(() => "written", (e: unknown) => String(e))).toContain("must equal the approved")
      expect(await db.productVersion.create({ data: { ...base, balloonPct: 0.2, rateBasis: "PRIME", rateMarginPa: 0.03 } }).then(() => "written", (e: unknown) => String(e))).toContain("must equal the approved")
      expect(await db.productVersion.create({ data: { ...base, balloonPct: 0.2, changeRequestId: "nothing" } }).then(() => "written", (e: unknown) => String(e))).toContain("only by an approved")
    })

    it("an NCA lender's version with a balloon or a variable rate is refused at submission", async () => {
      resetActiveJurisdiction()
      const product = await db.loanProduct.create({ data: { tenantId, code: `Z${t.slice(0, 6)}`, name: "Personal", productType: "PERSONAL", minAmount: 100_000, maxAmount: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" } })
      const { submitted } = await proposeVersion(product.id, config({ minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 90, maxTermDays: 180, interestRatePm: 0.01 }))
      expect(submitted.status).toBe(422)
      expect(JSON.stringify(await submitted.json())).toContain("variableRate")
    })
  })

  describe("repricing", () => {
    let productId: string
    let versionId: string
    const terms: RepaymentTerms = { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, instalments: 12, balloonPct: 0.3 }
    beforeAll(async () => {
      setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
      const product = await created({ code: `V${t.slice(0, 8)}`, productType: "PERSONAL" })
      productId = product.id
      const { change } = await proposeVersion(productId, config({ variableRate: { basis: "LENDER_BASE", marginPa: 0.03 } }))
      await approveRequest(change.id)
      versionId = (await db.productVersion.findFirstOrThrow({ where: { tenantId, productId } })).id
    })
    const bases = { rate: 0.09, date: day(-200), marginPa: 0.03 }
    const start = new Date(Date.now() - 95 * 86_400_000)
    const book = () => bookLoan(productId, versionId, { terms, ratePm: 0.01, start, reference: bases })

    it("appends a terms row, regenerates the untouched rows, reconciles to the cent, moves the totals, audited, and does it once", async () => {
      const { loanId, calc } = await book()
      const before = await scheduleOf(loanId)
      await db.repaymentSchedule.updateMany({ where: { loanId, installmentNo: 1 }, data: { status: "PAID", totalPaid: before[0]!.totalDue } })
      await approveRate(day(-1), "0.11", "LENDER_BASE")
      const response = await sweep()
      expect(response.status).toBe(200)
      expect((await response.json()).perTenant.find((r: { tenantId: string }) => r.tenantId === tenantId)).toMatchObject({ failed: 0 })

      const rows = await db.loanTerms.findMany({ where: { loanId }, orderBy: { sequence: "asc" } })
      expect(rows).toHaveLength(2)
      expect(rows[1]).toMatchObject({ sequence: 2, interestRatePm: Math.round((0.14 / 12) * 1e8) / 1e8, referenceRate: 0.11, rateMarginPa: 0.03, balloonCents: 300_000, rateBasis: "LENDER_BASE" })
      expect(rows[0]).toMatchObject({ interestRatePm: 0.01 })

      const after = await scheduleOf(loanId)
      expect(after.map((r) => r.dueDate)).toEqual(before.map((r) => r.dueDate))
      expect(sum(after.map((r) => r.principalDue))).toBe(1_000_000)
      expect(after.slice(0, 4).map((r) => r.totalDue)).toEqual(before.slice(0, 4).map((r) => r.totalDue))
      expect(after[4]!.totalDue).toBeGreaterThan(before[4]!.totalDue)
      expect(after.at(-1)!.principalDue).toBeGreaterThan(300_000)
      expect(after.every((r) => r.totalDue === r.principalDue + r.interestDue + r.feesDue + r.creditLifePremiumDue)).toBe(true)

      const delta = sum(after.map((r) => r.interestDue)) - sum(before.map((r) => r.interestDue))
      expect(delta).toBeGreaterThan(0)
      const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId } })
      expect(loan).toMatchObject({ interestRatePm: rows[1]!.interestRatePm, totalInterest: calc.totalInterest + delta, totalRepayable: calc.totalRepayable + delta, contractualTotalInterest: calc.totalInterest + delta, outstandingPrincipal: 1_000_000 })
      const audit = await db.auditLog.findMany({ where: { tenantId, entityId: loanId, action: "LOAN_RATE_REPRICED" } })
      expect(audit).toHaveLength(1)
      expect(audit[0]!.newValue).toMatchObject({ sequence: 2, interestDelta: delta })

      expect((await sweep()).status).toBe(200)
      expect(await db.loanTerms.count({ where: { loanId } })).toBe(2)
      expect((await scheduleOf(loanId)).map((r) => r.totalDue)).toEqual(after.map((r) => r.totalDue))
    })

    it("two racing runs reprice once: the second waits on the loan lock and finds it done", async () => {
      const { loanId } = await book()
      await approveRate(day(-2), "0.12", "LENDER_BASE")
      const reference = { rate: 0.12, effectiveDate: day(-2) }
      const go = () => prisma.$transaction((tx) => repriceLoan(tx, { tenantId, loanId, basis: "LENDER_BASE", reference, today: TODAY }))
      const outcomes = await Promise.all([go(), go()])
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["already_repriced", "repriced"])
      expect(await db.loanTerms.count({ where: { loanId } })).toBe(2)
    })

    it("the database refuses a gap in the sequence, a repeated sequence, and any change to a row", async () => {
      const { loanId } = await book()
      const first = await db.loanTerms.findFirstOrThrow({ where: { loanId } })
      const { id: _id, createdAt: _at, pricingInputs: _inputs, ...row } = first
      expect(await db.loanTerms.create({ data: { ...row, sequence: 1 } }).then(() => "written", (e: unknown) => String(e))).toContain("next row")
      expect(await db.loanTerms.create({ data: { ...row, sequence: 3 } }).then(() => "written", (e: unknown) => String(e))).toContain("next row")
      expect(await db.loanTerms.update({ where: { id: first.id }, data: { interestRatePm: 0.02 } }).then(() => "written", (e: unknown) => String(e))).toContain("never change")
    })

    it("the database refuses a repricing row no approved reference value backs, or one that changes the loan's margin", async () => {
      const { loanId } = await book()
      const effective = day(-3)
      await approveRate(effective, "0.115", "LENDER_BASE")
      const first = await db.loanTerms.findFirstOrThrow({ where: { loanId } })
      const { id: _id, createdAt: _at, pricingInputs: _inputs, ...row } = first
      const write = (over: Record<string, unknown>) => db.loanTerms.create({ data: { ...row, sequence: 2, referenceEffectiveDate: dbDate(effective), referenceRate: 0.115, ...over } }).then(() => "written", (e: unknown) => String(e))
      expect(await write({ referenceRate: 0.2 })).toContain("approved reference rate")
      expect(await write({ referenceEffectiveDate: dbDate(day(-4)) })).toContain("approved reference rate")
      expect(await write({ rateMarginPa: 0.01 })).toContain("approved reference rate")
      expect(await write({ rateBasis: "PRIME" })).toContain("approved reference rate")
      expect(await write({})).toBe("written")
    })

    it("does nothing to a loan that is not active, or for an NCA lender", async () => {
      const { loanId } = await book()
      await db.loan.update({ where: { id: loanId }, data: { status: "COMPLETED" } })
      await sweep()
      expect(await db.loanTerms.count({ where: { loanId } })).toBe(1)
      resetActiveJurisdiction()
      expect(await (await sweep()).json()).toMatchObject({ skipped: expect.stringContaining("NCA") })
    })
  })

  describe("reference rates outside the NCA", () => {
    const decide = (id: string, decision = "APPROVE") => decideRate(request(`/api/products/lending-rates/${id}/decide`, "POST", { decision }), { params: Promise.resolve({ id }) })
    const record = async (who: keyof typeof staff, effectiveDate: string, basis = "PRIME") => {
      signIn(who)
      return recordRate(request("/api/products/lending-rates", "POST", { basis, effectiveDate, rate: "0.1" }))
    }

    it("takes two people, and only the bases a variable rate may follow", async () => {
      expect((await record("officer", day(30))).status).toBe(403)
      expect((await record("maker", day(31), "JIBAR")).status).toBe(400)
      const recorded = await record("maker", day(32))
      expect(recorded.status).toBe(201)
      const { id, status } = await recorded.json()
      expect(status).toBe("PENDING")
      expect((await decide(id)).status).toBe(403)
      signIn("maker2")
      expect((await decide(id)).status).toBe(403)
      signIn("checker")
      expect((await decide(id, "MAYBE")).status).toBe(400)
      expect((await decide(id)).status).toBe(200)
      expect((await decide(id)).status).toBe(409)
    })

    it("refuses the person who recorded it, even with the authority to decide", async () => {
      const recorded = await record("checker", day(33))
      const { id } = await recorded.json()
      expect((await decide(id)).status).toBe(403)
      expect((await db.referenceRate.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING")
    })

    it("needs the session's second factor where the lender requires one", async () => {
      const { id } = await (await record("maker", day(34))).json()
      await db.tenantConfig.update({ where: { tenantId }, data: { requireStaffTotp: true } })
      session.current = { user: { id: staff.checker, email: `${staff.checker}@a5b-it.test`, role: "ADMIN", tenantId, totpVerified: false } }
      const refused = await decide(id)
      await db.tenantConfig.update({ where: { tenantId }, data: { requireStaffTotp: false } })
      expect(refused.status).toBe(403)
      expect((await refused.json()).code).toBe("TOTP_REQUIRED")
    })

    it("does not exist for an NCA lender", async () => {
      resetActiveJurisdiction()
      expect((await record("maker", day(35))).status).toBe(404)
    })
  })

  describe("the product types", () => {
    const client = async (over: Record<string, unknown> = {}) => {
      const n = randomUUID().replaceAll("-", "").slice(0, 12)
      return db.client.create({ data: { tenantId, idNumber: `80${n}`, firstName: "Lineo", lastName: `Member${n.slice(0, 4)}`, email: `${n}@client.invalid`, phone: "0820000001", employmentStatus: "EMPLOYED", ...over } })
    }
    const application = async (productId: string, clientId: string, over: Record<string, unknown> = {}) => {
      const n = randomUUID().replaceAll("-", "").slice(0, 12)
      return db.loanApplication.create({ data: { tenantId, reference: `APP-${n}`, clientId, productId, appliedAmount: 200_000, appliedTermDays: 90, status: "SUBMITTED", ...over } })
    }
    const gate = (app: { id: string; clientId: string | null; productId: string; loanPurposeCategory: string | null }, productType: string, principalCents = 200_000, limitCents = 5_000_000) =>
      productTypeRefusal(prisma, tenantId, { ...app, product: { productType } }, { principalCents, limitCents })
    const facts = (id: string, body: unknown) => { signIn("officer"); return setFacts(request(`/api/applications/${id}/product-facts`, "PUT", body), { params: Promise.resolve({ id }) }) }

    it("salary-backed: refused until the facts are set; whoever sets them is on the input staff; closed applications are refused; the deduction list follows", async () => {
      const product = await created()
      const borrower = await client()
      const app = await application(product.id, borrower.id)
      expect(await gate(app, "SALARY_BACKED")).toContain("employer")
      expect((await facts(app.id, { employerName: "Maluti Mining", payrollNumber: "P-7" })).status).toBe(200)
      expect(await gate(app, "SALARY_BACKED")).toBeNull()
      expect((await db.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).inputStaffIds).toContain(staff.officer)
      expect(await db.auditLog.count({ where: { tenantId, entityId: app.id, action: "APPLICATION_PRODUCT_FACTS_SET", userId: staff.officer } })).toBe(1)

      const closed = await application(product.id, (await client()).id, { status: "DECLINED" })
      expect((await facts(closed.id, { employerName: "Other", payrollNumber: "P-8" })).status).toBe(409)

      const due = new Date(`${day(10)}T08:00:00+02:00`)
      const n = randomUUID().slice(0, 8)
      const loan = await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: app.id, clientId: borrower.id, productId: product.id, principal: 200_000, totalInterest: 0, initiationFee: 0, totalRepayable: 200_000, outstandingPrincipal: 200_000, startDate: new Date(), maturityDate: due, interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "ACTIVE" } })
      await db.repaymentSchedule.create({ data: { tenantId, loanId: loan.id, installmentNo: 1, dueDate: due, principalDue: 200_000, interestDue: 0, feesDue: 0, totalDue: 200_000, totalPaid: 50_000, status: "PARTIAL" } })
      signIn("officer")
      const month = day(10).slice(0, 7)
      const listed = await (await deductions(request(`/api/products/check-off/deductions?month=${month}`))).json()
      expect(listed.rows).toEqual([expect.objectContaining({ employer: "Maluti Mining", payrollNumber: "P-7", loanReference: `LN-${n}`, amountCents: 150_000 })])
      const csv = await deductions(request(`/api/products/check-off/deductions?month=${month}&format=csv`))
      expect(await csv.text()).toContain('"Maluti Mining","P-7"')
      expect(await db.auditLog.count({ where: { tenantId, action: "CHECK_OFF_DEDUCTIONS_EXPORTED", userId: staff.officer } })).toBe(1)
    })

    it("SME: the business's facts and a business purpose", async () => {
      const product = await created({ productType: "SME" })
      const app = await application(product.id, (await client()).id, { loanPurposeCategory: "BUSINESS" })
      expect(await gate(app, "SME")).toContain("business's name")
      expect((await facts(app.id, { businessName: "Maluti Traders", businessRegistrationNumber: "2020/1", annualTurnoverCents: 900_000_000 })).status).toBe(200)
      expect(await gate(app, "SME")).toBeNull()
      expect(await gate({ ...app, loanPurposeCategory: "MEDICAL" }, "SME")).toContain("business purpose")
      expect((await facts(app.id, { businessName: "x" })).status).toBe(422)
    })

    it("group: a real group of the lender's clients, refused while a member is in arrears", async () => {
      const product = await created({ productType: "GROUP" })
      const [a, b] = [await client(), await client()]
      signIn("officer")
      expect((await createGroup(request("/api/products/groups", "POST", { name: "One member", memberIdNumbers: [a.idNumber] }))).status).toBe(422)
      expect((await createGroup(request("/api/products/groups", "POST", { name: "Ghost", memberIdNumbers: [a.idNumber, "000"] }))).status).toBe(422)
      const made = await createGroup(request("/api/products/groups", "POST", { name: `Group ${t}`, memberIdNumbers: [a.idNumber, b.idNumber] }))
      expect(made.status).toBe(201)
      const { group } = await made.json()
      const app = await application(product.id, a.id)
      expect(await gate(app, "GROUP")).toContain("lending group")
      expect((await facts(app.id, { borrowerGroupId: "not-a-group" })).status).toBe(422)
      expect((await facts(app.id, { borrowerGroupId: group.id })).status).toBe(200)
      expect(await gate(app, "GROUP")).toBeNull()

      const other = await application(product.id, b.id)
      const n = randomUUID().slice(0, 8)
      await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: other.id, clientId: b.id, productId: product.id, principal: 100_000, totalInterest: 0, initiationFee: 0, totalRepayable: 100_000, outstandingPrincipal: 100_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "ACTIVE", daysInArrears: 3 } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
    })

    it("revolving: what is still owed counts against the limit, and a repaid draw frees it", async () => {
      const product = await created({ productType: "REVOLVING" })
      const borrower = await client()
      const first = await application(product.id, borrower.id)
      const n = randomUUID().slice(0, 8)
      const loan = await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: first.id, clientId: borrower.id, productId: product.id, principal: 400_000, totalInterest: 0, initiationFee: 0, totalRepayable: 400_000, outstandingPrincipal: 400_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "ACTIVE" } })
      const second = { id: "draw", clientId: borrower.id, productId: product.id, loanPurposeCategory: null }
      expect(await gate(second, "REVOLVING", 200_000, 500_000)).toContain("exceeds the revolving limit")
      expect(await gate(second, "REVOLVING", 100_000, 500_000)).toBeNull()
      await db.loan.update({ where: { id: loan.id }, data: { outstandingPrincipal: 300_000 } })
      expect(await gate(second, "REVOLVING", 200_000, 500_000)).toBeNull()
      // A default does not free the limit: the balance is still owed.
      await db.loan.update({ where: { id: loan.id }, data: { status: "DEFAULTED" } })
      expect(await gate(second, "REVOLVING", 300_000, 500_000)).toContain("exceeds the revolving limit")
      await db.loan.update({ where: { id: loan.id }, data: { status: "WRITTEN_OFF", writeOffAt: new Date() } })
      expect(await gate(second, "REVOLVING", 300_000, 500_000)).toContain("exceeds the revolving limit")
    })

    it("a group member's default or write-off stops the group, and whoever edits the group joins its open applications' input staff", async () => {
      const product = await created({ productType: "GROUP" })
      const [a, b, c] = [await client(), await client(), await client()]
      signIn("officer")
      const { group } = await (await createGroup(request("/api/products/groups", "POST", { name: `Edit ${t}`, memberIdNumbers: [a.idNumber, b.idNumber] }))).json()
      const app = await application(product.id, a.id)
      expect((await facts(app.id, { borrowerGroupId: group.id })).status).toBe(200)

      const other = await application(product.id, b.id)
      const n = randomUUID().slice(0, 8)
      const loan = await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: other.id, clientId: b.id, productId: product.id, principal: 100_000, totalInterest: 0, initiationFee: 0, totalRepayable: 100_000, outstandingPrincipal: 100_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "DEFAULTED" } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
      await db.loan.update({ where: { id: loan.id }, data: { status: "PENDING_WRITE_OFF" } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
      await db.loan.update({ where: { id: loan.id }, data: { status: "WRITTEN_OFF", writeOffAt: new Date() } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
      await db.loan.update({ where: { id: loan.id }, data: { status: "COMPLETED" } })
      expect(await gate(app, "GROUP")).toBeNull()

      signIn("checker")
      const replaced = await editGroup(request(`/api/products/groups/${group.id}`, "PUT", { memberIdNumbers: [a.idNumber, c.idNumber] }), { params: Promise.resolve({ id: group.id }) })
      expect(replaced.status).toBe(200)
      const after = await db.loanApplication.findUniqueOrThrow({ where: { id: app.id } })
      expect(after.inputStaffIds).toContain(staff.checker)
      expect(await groupEditedBy(prisma, tenantId, app.id, staff.checker)).toBe(true)
      expect(await groupEditedBy(prisma, tenantId, app.id, staff.maker)).toBe(false)
    })
  })
})
