/**
 * What the A5b real-Postgres suites share: one lender per file, staff of each role, and the real routes to propose a product, a version
 * and a reference value. Only the session (./a5b-session.integration-fixture.ts) and the instance's jurisdiction are stubbed.
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "vitest"
import { GET as cron } from "@/app/api/cron/loan-rate-reprice/route"
import { POST as act } from "@/app/api/maker-checker/[id]/[action]/route"
import { POST as draftChange } from "@/app/api/maker-checker/route"
import { POST as createProduct } from "@/app/api/products/loan/route"
import { POST as decideRate } from "@/app/api/products/lending-rates/[id]/decide/route"
import { POST as recordRate } from "@/app/api/products/lending-rates/route"
import { dbDate } from "@/lib/asset-finance/dates"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"
import { sastCalendarDate } from "@/lib/date/sast"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { calculateLoan } from "@/lib/loan-calculator"
import { prisma } from "@/lib/prisma"
import { session } from "./a5b-session.integration-fixture"
import type { RepaymentTerms } from "./types"

export const suite = process.env.RUN_A5B_IT === "1" ? describe.sequential : describe.skip
export const db = new PrismaClient()
export const t = randomUUID().replaceAll("-", "").slice(0, 14)
export const tenantId = `t_a5b_${t}`
export const host = `a5b-${t}.a5b-it.test`
export const staff = { maker: `u_mk_${t}`, maker2: `u_mk2_${t}`, checker: `u_ck_${t}`, officer: `u_of_${t}` }
export const roles = { maker: "LOAN_ADMIN", maker2: "LOAN_ADMIN", checker: "ADMIN", officer: "CREDIT_OFFICER" } as const
export const day = (offset: number) => sastCalendarDate(new Date(Date.now() + offset * 86_400_000))
export const TODAY = day(0)
export const cronSecret = randomUUID()

export const signIn = (who: keyof typeof staff) => { session.current = { user: { id: staff[who], email: `${staff[who]}@a5b-it.test`, role: roles[who], tenantId, totpVerified: true } } }
export const request = (path: string, method = "GET", body?: unknown) => new NextRequest(`http://${host}${path}`, { method, headers: { host, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
export const approveRequest = (id: string, who: keyof typeof staff = "checker") => { signIn(who); return act(request(`/api/maker-checker/${id}/approve`, "POST", {}), { params: Promise.resolve({ id, action: "approve" }) }) }
export const form = (over: Record<string, unknown> = {}) => ({
  code: `C${randomUUID().slice(0, 8).toUpperCase()}`, name: "Payroll loan", productType: "SALARY_BACKED", minAmount: 1_000, maxAmount: 50_000, minTermDays: 30, maxTermDays: 720, interestRatePm: 2,
  interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 5, initiationFeeMax: 0, monthlyServiceFee: 0, active: true, reason: "A product for the launch", ...over,
})
export const created = async (over: Record<string, unknown> = {}) => {
  signIn("maker")
  const body = form(over)
  const response = await createProduct(request("/api/products/loan", "POST", body))
  expect(response.status).toBe(202)
  const { request: change } = await response.json()
  expect((await approveRequest(change.id)).status).toBe(200)
  return db.loanProduct.findFirstOrThrow({ where: { tenantId, code: body.code as string } })
}
export const config = (over: Record<string, unknown> = {}) => ({
  minAmountCents: 100_000, maxAmountCents: 5_000_000, minTermDays: 90, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMaxCents: 0,
  monthlyServiceFeeCents: 0, repayment: { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, balloonPct: 0.3 }, variableRate: { basis: "PRIME", marginPa: 0.03 },
  collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null }, ...over,
})
export const proposeVersion = async (productId: string, cfg: Record<string, unknown>) => {
  signIn("maker")
  const drafted = await draftChange(request("/api/maker-checker", "POST", { kind: "PRODUCT_VERSION", title: "Variable", payload: { productId, effectiveFrom: TODAY, reason: "Variable rate launch", config: cfg } }))
  expect(drafted.status).toBe(201)
  const { request: change } = await drafted.json()
  const submitted = await act(request(`/api/maker-checker/${change.id}/submit`, "POST", {}), { params: Promise.resolve({ id: change.id, action: "submit" }) })
  return { change, submitted }
}
export const approveRate = async (effectiveDate: string, rate: string, basis = "PRIME") => {
  signIn("maker")
  const recorded = await recordRate(request("/api/products/lending-rates", "POST", { basis, effectiveDate, rate }))
  expect(recorded.status).toBe(201)
  const { id } = await recorded.json()
  signIn("checker")
  expect((await decideRate(request(`/api/products/lending-rates/${id}/decide`, "POST", { decision: "APPROVE" }), { params: Promise.resolve({ id }) })).status).toBe(200)
}

/** A loan booked as the disbursement route books one: the engine's schedule, and terms sequence 1 frozen from the approval. */
export async function bookLoan(productId: string, versionId: string, opts: { terms: RepaymentTerms; ratePm: number; start: Date; reference: { rate: number; date: string; marginPa: number } }) {
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
export const scheduleOf = (loanId: string) => db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
export const sweep = async () => cron(new NextRequest(`http://${host}/api/cron/loan-rate-reprice`, { headers: { "x-cron-secret": cronSecret } }))

/** The lender of this file, created once, and Lesotho as the instance's jurisdiction around every test. */
export function registerA5bLender(): void {
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
}
