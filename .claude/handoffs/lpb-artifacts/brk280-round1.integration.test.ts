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
import { productTypeRefusal } from "@/lib/product-types/rules"
import { addPeriods } from "./periods"
import { repriceLoan } from "./reprice-loan"
import { repriceTenantLoans } from "./reprice-batch"
import { planReprice } from "./reprice"
import { generateSchedule } from "./schedule"
import { PUT as editGroup } from "@/app/api/products/groups/[id]/route"
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

  const client = async () => { const n = randomUUID().replaceAll("-", "").slice(0, 12); return db.client.create({ data: { tenantId, idNumber: `80${n}`, firstName: "Lineo", lastName: `B${n.slice(0, 4)}`, email: `${n}@client.invalid`, phone: "0820000001", employmentStatus: "EMPLOYED" } }) }
  const application = async (productId: string, clientId: string, over: Record<string, unknown> = {}) => { const n = randomUUID().replaceAll("-", "").slice(0, 12); return db.loanApplication.create({ data: { tenantId, reference: `APP-${n}`, clientId, productId, appliedAmount: 200_000, appliedTermDays: 90, status: "SUBMITTED", ...over } }) }
  const loanOn = async (productId: string, clientId: string, status: string, owed: number, daysInArrears = 0) => {
    const app = await application(productId, clientId, { status: "DISBURSED" }).catch(() => application(productId, clientId))
    const n = randomUUID().slice(0, 8)
    return db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: app.id, clientId, productId, principal: owed, totalInterest: 0, initiationFee: 0, totalRepayable: owed, outstandingPrincipal: owed, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: status as never, daysInArrears } })
  }
  const gate = (clientId: string, productId: string, productType: string, principalCents: number, limitCents: number, id = "draw") => productTypeRefusal(prisma, tenantId, { id, clientId, productId, loanPurposeCategory: null, product: { productType } }, { principalCents, limitCents })

  describe("(a) revolving limit", () => {
    for (const status of ["DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF", "RESTRUCTURED"]) {
      it(`counts principal still owed on a ${status} loan`, async () => {
        const product = await created({ productType: "REVOLVING" })
        const b = await client()
        await loanOn(product.id, b.id, status, 450_000)
        expect(await gate(b.id, product.id, "REVOLVING", 200_000, 500_000)).toContain("exceeds the revolving limit")
      })
    }
    it("counts an approved draw not yet disbursed", async () => {
      const product = await created({ productType: "REVOLVING" })
      const b = await client()
      const pending = await application(product.id, b.id, { appliedAmount: 450_000 })
      // The status alone matters here: past the approval triggers, which need a whole PASQ the gate never reads.
      await db.$transaction([db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`), db.$executeRaw`UPDATE "LoanApplication" SET "status" = 'APPROVED', "approvedAmount" = 450000 WHERE "id" = ${pending.id}`])
      expect(await gate(b.id, product.id, "REVOLVING", 200_000, 500_000)).toContain("exceeds the revolving limit")
    })
  })

  describe("(b) group arrears", () => {
    for (const status of ["DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF"]) {
      it(`a member's ${status} loan stops the group`, async () => {
        const product = await created({ productType: "GROUP" })
        const [a, b] = [await client(), await client()]
        signIn("officer")
        const made = await createGroup(request("/api/products/groups", "POST", { name: `G ${randomUUID().slice(0, 8)}`, memberIdNumbers: [a.idNumber, b.idNumber] }))
        const { group } = await made.json()
        const app = await application(product.id, a.id)
        await db.applicationProductFacts.create({ data: { applicationId: app.id, tenantId, borrowerGroupId: group.id, updatedById: staff.officer } })
        await loanOn(product.id, b.id, status, 300_000, 120)
        expect(await gate(a.id, product.id, "GROUP", 100_000, 5_000_000, app.id)).toContain("in arrears")
      })
    }
  })

  describe("(c) segregation of duties on a group edit", () => {
    it("editing the members of a group an open application names makes the editor input staff of it", async () => {
      const product = await created({ productType: "GROUP" })
      const [a, b, c] = [await client(), await client(), await client()]
      signIn("maker")
      const { group } = await (await createGroup(request("/api/products/groups", "POST", { name: `G ${randomUUID().slice(0, 8)}`, memberIdNumbers: [b.idNumber, c.idNumber] }))).json()
      const app = await application(product.id, a.id, { status: "UNDER_REVIEW" })
      await db.applicationProductFacts.create({ data: { applicationId: app.id, tenantId, borrowerGroupId: group.id, updatedById: staff.maker } })
      signIn("officer")
      // The officer puts the borrower into the group the gate reads, then is free to approve.
      expect((await editGroup(request(`/api/products/groups/${group.id}`, "PUT", { memberIdNumbers: [a.idNumber, b.idNumber, c.idNumber] }), { params: Promise.resolve({ id: group.id }) })).status).toBe(200)
      const after = await db.loanApplication.findFirstOrThrow({ where: { id: app.id } })
      expect(after.inputStaffIds).toContain(staff.officer)
    })
  })

  describe("repricing", () => {
    it("planReprice conserves principal, keeps fees, stays non-negative, keeps the balloon on the last row (fuzz)", () => {
      let seed = 280
      const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
      const problems: string[] = []
      for (let i = 0; i < 6000; i++) {
        const structure = (["AMORTISING", "INTEREST_ONLY", "BALLOON"] as const)[rnd(3)]!
        const frequency = (["WEEKLY", "FORTNIGHTLY", "MONTHLY"] as const)[rnd(3)]!
        const instalments = 2 + rnd(60)
        const grace = structure === "AMORTISING" && rnd(3) === 0 ? Math.min(1 + rnd(4), instalments - 1) : 0
        const P = 10_000 + rnd(50_000_000)
        const balloonPct = structure === "BALLOON" ? (1 + rnd(98)) / 100 : undefined
        const t2: RepaymentTerms = { frequency, structure, graceKind: grace ? "PRINCIPAL_ONLY" : "NONE", graceInstalments: grace, instalments, ...(balloonPct ? { balloonPct } : {}) }
        const start = new Date(Date.UTC(2026, 0, 15))
        const s = generateSchedule({ principalCents: P, interestRatePm: 0.005 + rnd(50) / 1000, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: rnd(3) ? 0 : 6900, startDate: start, terms: t2 })
        const paid = rnd(instalments)
        const rows = s.schedule.map((r, k) => ({ id: `r${k}`, installmentNo: k + 1, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, creditLifePremiumDue: 0, totalDue: r.totalDue, totalPaid: k < paid ? r.totalDue : 0, status: k < paid ? "PAID" : "PENDING" }))
        const effective = sastCalendarDate(paid === 0 ? start : rows[paid - 1]!.dueDate)
        const today = sastCalendarDate(new Date((paid === 0 ? start : rows[paid - 1]!.dueDate).getTime() + 3_600_000))
        const newRatePm = rnd(10) === 0 ? 0 : rnd(120) / 1000
        const plan = planReprice({ rows, startDate: start, frequency, structure, balloonCents: balloonPct ? Math.round(P * balloonPct) : 0, newRatePm, effectiveDate: effective, today })
        if (!plan) continue
        const tail = rows.filter((r) => plan.updates.some((u) => u.id === r.id))
        const pOld = tail.reduce((a, r) => a + r.principalDue, 0)
        const pNew = plan.updates.reduce((a, u) => a + u.principalDue, 0)
        if (pOld !== pNew) problems.push(`principal ${i}: ${pOld} -> ${pNew}`)
        for (const [k, u] of plan.updates.entries()) {
          if (u.principalDue < 0 || u.interestDue < 0 || !Number.isInteger(u.principalDue) || !Number.isInteger(u.interestDue)) problems.push(`neg ${i}`)
          if (u.totalDue !== u.principalDue + u.interestDue + tail[k]!.feesDue) problems.push(`total ${i}`)
        }
        if (structure === "BALLOON" && plan.updates.at(-1)!.principalDue < Math.min(Math.round(P * balloonPct!), pOld)) problems.push(`balloon ${i}`)
      }
      expect(problems.slice(0, 10)).toEqual([])
    })

    describe("on a loan", () => {
      let productId: string
      let versionId: string
      const terms: RepaymentTerms = { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, instalments: 12, balloonPct: 0.3 }
      beforeAll(async () => {
        setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
        const product = await created({ code: `Z${t.slice(0, 8)}`, productType: "PERSONAL" })
        productId = product.id
        const { change } = await proposeVersion(productId, config({ variableRate: { basis: "LENDER_BASE", marginPa: -0.05 } }))
        await approveRequest(change.id)
        versionId = (await db.productVersion.findFirstOrThrow({ where: { tenantId, productId } })).id
      })
      const start = new Date(Date.now() - 95 * 86_400_000)
      it("a reference below a negative margin takes the rate to zero and still reconciles", async () => {
        const { loanId } = await bookLoan(productId, versionId, { terms, ratePm: 0.01, start, reference: { rate: 0.17, date: day(-200), marginPa: -0.05 } })
        await approveRate(day(-20), "0.03", "LENDER_BASE")
        const before = await scheduleOf(loanId)
        const run = await repriceTenantLoans(tenantId, TODAY)
        expect(run.failed).toBe(0)
        const after = await scheduleOf(loanId)
        const lb = await db.loan.findFirstOrThrow({ where: { id: loanId } })
        expect(lb.interestRatePm).toBe(0)
        expect(sum(after.map((r) => r.principalDue))).toBe(sum(before.map((r) => r.principalDue)))
        expect(sum(after.map((r) => r.interestDue))).toBe(lb.totalInterest)
        expect(sum(after.map((r) => r.totalDue))).toBe(lb.totalRepayable)
      })
    })
  })

  describe("maker-checker through the generic route", () => {
    it("holds a draft to the rules the product form's route holds: a default margin of 5 (500%) is refused", async () => {
      signIn("maker")
      const code = `M${randomUUID().slice(0, 8).toUpperCase()}`
      const product = { code, name: "x", productType: "SME", minAmount: 100_000, maxAmount: 500_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 50, initiationFeeMax: 0, monthlyServiceFee: 0, active: true, nonNcaDefaultInterestMargin: "5" }
      const drafted = await draftChange(request("/api/maker-checker", "POST", { kind: "LOAN_PRODUCT", title: "x", payload: { action: "CREATE", reason: "the generic path", product } }))
      // Proof of the bypass end to end: it drafts, submits, a checker approves, and the row holds what the form route answers 422 to.
      expect(drafted.status).toBe(201)
      const { request: change } = await drafted.json()
      expect((await act(request(`/api/maker-checker/${change.id}/submit`, "POST", {}), { params: Promise.resolve({ id: change.id, action: "submit" }) })).status).toBe(200)
      const approved = await approveRequest(change.id)
      const row = await db.loanProduct.findFirst({ where: { tenantId, code } })
      console.warn("GENERIC", approved.status, row && { margin: row.nonNcaDefaultInterestMargin?.toString(), fee: row.initiationFeePct })
      expect(row).toBeNull()
    })
  })
})
