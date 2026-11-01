/**
 * A5b, real Postgres and real routes: an approved reference value reprices a loan once, reconciles to the cent, leaves closed days of default interest alone, and takes two people to record.
 *
 *   RUN_A5B_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/product-engine/a5b-repricing.integration.test.ts
 */
import { beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", async () => {
  const { session } = await import("./a5b-session.integration-fixture")
  return { auth: vi.fn(async () => session.current) }
})
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: vi.fn(async () => undefined) }))

import { POST as decideRate } from "@/app/api/products/lending-rates/[id]/decide/route"
import { POST as recordRate } from "@/app/api/products/lending-rates/route"
import { dbDate } from "@/lib/asset-finance/dates"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { loadChargesReplay } from "@/lib/loan/charges-replay"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { session } from "./a5b-session.integration-fixture"
import { TODAY, approveRate, approveRequest, bookLoan, config, created, day, db, proposeVersion, registerA5bLender, request, scheduleOf, signIn, staff, suite, sum, sweep, t, tenantId } from "./a5b.integration-fixture"
import { repriceLoan } from "./reprice-loan"
import type { RepaymentTerms } from "./types"

suite("A5b repricing (real Postgres, real routes)", () => {
  registerA5bLender()

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
      const rate = Math.round((0.145 / 12) * 1e8) / 1e8
      const write = (over: Record<string, unknown>) => db.loanTerms.create({ data: { ...row, sequence: 2, referenceEffectiveDate: dbDate(effective), referenceRate: 0.115, interestRatePm: rate, baseRatePm: rate, ...over } }).then(() => "written", (e: unknown) => String(e))
      expect(await write({ referenceRate: 0.2 })).toContain("approved reference rate")
      expect(await write({ referenceEffectiveDate: dbDate(day(-4)) })).toContain("approved reference rate")
      expect(await write({ rateMarginPa: 0.01 })).toContain("approved reference rate")
      expect(await write({ rateBasis: "PRIME" })).toContain("approved reference rate")
      expect(await write({})).toBe("written")
    })

    it("the database refuses a repricing row whose rate is not the value's, or whose structure moved", async () => {
      const { loanId } = await book()
      const effective = day(-5)
      await approveRate(effective, "0.13", "LENDER_BASE")
      const first = await db.loanTerms.findFirstOrThrow({ where: { loanId } })
      const { id: _id, createdAt: _at, pricingInputs: _inputs, ...row } = first
      const rate = Math.round((0.16 / 12) * 1e8) / 1e8
      const write = (over: Record<string, unknown>) => db.loanTerms.create({ data: { ...row, sequence: 2, referenceEffectiveDate: dbDate(effective), referenceRate: 0.13, interestRatePm: rate, baseRatePm: rate, ...over } }).then(() => "written", (e: unknown) => String(e))
      expect(await write({ interestRatePm: 0.5, baseRatePm: 0.5 })).toContain("approved reference rate")
      expect(await write({ instalments: 24 })).toContain("approved reference rate")
      expect(await write({ balloonCents: 100_000 })).toContain("approved reference rate")
      expect(await write({})).toBe("written")
    })

    it("a value not approved, or not yet in effect, reprices nothing", async () => {
      const { loanId } = await book()
      await approveRate(day(5), "0.2", "LENDER_BASE")
      signIn("maker")
      await recordRate(request("/api/products/lending-rates", "POST", { basis: "LENDER_BASE", effectiveDate: day(-30), rate: "0.3" }))
      await db.loan.update({ where: { id: loanId }, data: { startDate: new Date(Date.now() - 95 * 86_400_000) } })
      await sweep()
      const rows = await db.loanTerms.findMany({ where: { loanId }, orderBy: { sequence: "desc" } })
      expect(rows.every((r) => r.referenceRate !== 0.2 && r.referenceRate !== 0.3)).toBe(true)
    })

    it("a zero rate reconciles: a reference below a negative margin floors at 0", async () => {
      const { loanId } = await bookLoan(productId, versionId, { terms, ratePm: 0.01, start, reference: { rate: 0.17, date: day(-300), marginPa: -0.05 } })
      const before = await scheduleOf(loanId)
      await approveRate(day(-40), "0.03", "LENDER_BASE")
      await sweep()
      const after = await scheduleOf(loanId)
      const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId } })
      expect(sum(after.map((r) => r.principalDue))).toBe(sum(before.map((r) => r.principalDue)))
      expect(sum(after.map((r) => r.interestDue))).toBe(loan.totalInterest)
      expect(sum(after.map((r) => r.totalDue))).toBe(loan.totalRepayable)
    })

    it("closed days of default interest stay at the rate of their day when the loan is repriced", async () => {
      const { loanId } = await book()
      await db.tenantConfig.update({ where: { tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-01-01T00:00:00+02:00") } })
      const accrued = async (asOf: Date) => (await runWithTenant(tenantId, () => prisma.$transaction(async (tx) => (await loadChargesReplay(tx as never, { tenantId, loanId }, asOf))!.result.interestAccrued)))
      const asOf = new Date(Date.now() - 2 * 86_400_000)
      const before = await accrued(asOf)
      expect(before).toBeGreaterThan(0)
      await prisma.$transaction((tx) => repriceLoan(tx, { tenantId, loanId, basis: "LENDER_BASE", reference: { rate: 0.13, effectiveDate: day(-5) }, today: TODAY }))
      expect((await db.loan.findUniqueOrThrow({ where: { id: loanId } })).interestRatePm).not.toBe(0.01)
      expect(await accrued(asOf)).toBe(before)
      await db.tenantConfig.update({ where: { tenantId }, data: { defaultChargesEnabled: false } })
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

    it("does not decide another basis: the repo rate is not this route's", async () => {
      const row = await db.referenceRate.create({ data: { tenantId, basis: "REPO", effectiveDate: dbDate(day(36)), rate: "0.07", requestedById: staff.maker } })
      signIn("checker")
      expect((await decide(row.id)).status).toBe(404)
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
})
