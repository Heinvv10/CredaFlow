/**
 * The PR #266 breaker's repros, ported: each replays the gate sequence decide-application.ts runs at approval and asserts the
 * approval is now REFUSED where the breaker booked an unlawful loan:
 *   1. approvalInterestCapCheck(application with its LoanProduct row)
 *   2. approvalTermsFor(...): the terms the loan is approved on, and the NCA issues with its version
 *   3. approvalInterestCapCheck(capApplicationFor(application, terms, loan)): the cap on the rate the loan is WRITTEN at
 *
 *   RUN_BRK266_IT=1 DATABASE_URL=... npx vitest run lib/product-engine/break266.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { asChecker, asMaker, createApplication, createLender } from "@/lib/decisioning/decisioning.integration-fixture"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { sastCalendarDate } from "@/lib/date/sast"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { runWithTenant } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { approvalInterestCapCheck, checkNcaInterestRateFor } from "@/lib/loan/nca-interest-cap.server"
import { ncaCreditType } from "@/lib/loan/nca-interest-cap"
import { createChargesLoan } from "@/lib/loan/charges.integration-fixture"
import { approvalTermsFor, capApplicationFor } from "./approval-terms"
import { activateDueVersions } from "./activate"
import { PRICING_RULE_KIND } from "./pricing"
import { PRODUCT_VERSION_KIND } from "./change-handlers"

const suite = process.env.RUN_BRK266_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const TODAY = sastCalendarDate(new Date())
const TOMORROW = sastCalendarDate(new Date(Date.now() + 86_400_000))

const cfg = (over: Record<string, unknown> = {}) => ({
  minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE",
  initiationFeeModel: "NCA_REG42", initiationFeePct: 0, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 6_900,
  repayment: null,
  collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null },
  ...over,
})

suite("PR #266 break attempts (real Postgres)", () => {
  afterEach(() => resetActiveJurisdiction())
  afterAll(async () => { await db.$disconnect(); await prisma.$disconnect() })

  async function setup(product: Record<string, unknown>) {
    const lender = await createLender(db)
    await db.loanProduct.update({ where: { id: lender.productId }, data: product })
    const as = <T>(fn: () => Promise<T>) => runWithTenant(lender.tenantId, fn)
    const propose = async (kind: string, payload: Record<string, unknown>) => {
      const r = await as(async () => {
        const d = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind, title: "x", payload })
        return submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
      })
      return as(() => approve({ tenantId: lender.tenantId, actor: asChecker(lender), id: r.id }))
    }
    return { lender, as, propose }
  }

  async function gates(lender: { tenantId: string }, applicationId: string, asOf: string) {
    const application = await db.loanApplication.findUniqueOrThrow({ where: { id: applicationId }, include: { product: true } })
    const capCheck = await approvalInterestCapCheck(prisma, lender.tenantId, application)
    const terms = await runWithTenant(lender.tenantId, () => approvalTermsFor(prisma, lender.tenantId, { id: application.id, productId: application.productId, appliedTermDays: application.appliedTermDays, riskGradeRank: application.riskGradeRank }, application.product as never, asOf))
    const versionedCap = terms.versioned
      ? await approvalInterestCapCheck(prisma, lender.tenantId, capApplicationFor(application, terms, { principalCents: application.appliedAmount, termDays: application.appliedTermDays }))
      : ({ ok: true } as const)
    return { application, capCheck, terms, versionedCap }
  }

  it("A. repeat short-term borrower: a pricing rule prices above Reg 42's 3% repeat cap and approval lets it through", async () => {
    const { lender, propose } = await setup({ minAmount: 100_000, maxAmount: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" })
    await propose(PRODUCT_VERSION_KIND, { productId: lender.productId, effectiveFrom: TODAY, reason: "Version under the engine", config: cfg() })
    await propose(PRICING_RULE_KIND, { action: "CREATE", rule: { productId: lender.productId, name: "Walk-in", segment: "WALKIN", channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: TODAY, validTo: null, priority: 0, rate: { mode: "SET", value: 0.05 }, initiationFeePct: null } })

    // the client already had a short-term loan this year (R2,000 from 2026-08-01, paid out)
    const other = await db.loanProduct.create({ data: { tenantId: lender.tenantId, code: "OTHER", name: "Other", productType: "MICRO", minAmount: 1, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, interestRatePm: 0.03, interestModel: "FLAT" } })
    const first = await createChargesLoan(db, { tenantId: lender.tenantId, userId: lender.makerId, productId: other.id })
    const second = await db.loanApplication.create({ data: { tenantId: lender.tenantId, reference: `APP-R-${Date.now()}`, clientId: first.clientId, productId: lender.productId, appliedAmount: 300_000, appliedTermDays: 90, status: "UNDER_REVIEW" } })
    await db.applicationPricingInput.create({ data: { applicationId: second.id, tenantId: lender.tenantId, segment: "WALKIN" } })

    const g = await gates(lender, second.id, TODAY)
    expect(ncaCreditType(300_000, 90)).toBe("SHORT_TERM")
    expect(g.capCheck.ok).toBe(true) // gate 1 checks the LoanProduct's 3%
    expect(g.terms.interestRatePm).toBe(0.05) // the rule prices it at 5% a month
    // Reg 42 limits this repeat short-term transaction to 3% a month: the cap on the rate it is written at refuses it
    expect(g.versionedCap).toMatchObject({ ok: false, reason: "REPEAT_SHORT_TERM" })
  })

  it("B. scan lead: no pricing rule, version in effect above the cap while LoanProduct still holds the old rate -> approved above the NCA maximum", async () => {
    const { lender, propose } = await setup({ minAmount: 100_000, maxAmount: 5_000_000, minTermDays: 30, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE" })
    const repo = await db.referenceRate.create({ data: { tenantId: lender.tenantId, basis: "REPO", effectiveDate: new Date("2026-01-01T00:00:00Z"), rate: "0.0775", requestedById: lender.makerId } })
    await db.referenceRate.update({ where: { id: repo.id }, data: { status: "APPROVED", decidedById: lender.checkerId, decidedAt: new Date() } })
    const unsecured = (rate: number) => cfg({ maxAmountCents: 5_000_000, minTermDays: 30, maxTermDays: 720, interestRatePm: rate })
    await propose(PRODUCT_VERSION_KIND, { productId: lender.productId, effectiveFrom: TODAY, reason: "v1 today", config: unsecured(0.02) })
    // v2 from tomorrow at 2.39% a month: lawful under repo 7.75% (cap 28.75% a year)
    await propose(PRODUCT_VERSION_KIND, { productId: lender.productId, effectiveFrom: TOMORROW, reason: "v2 tomorrow", config: unsecured(0.0239) })
    // the SARB feed records a cut (counts at once, approved or not): cap becomes 28.00% a year, ~2.333% a month
    await db.referenceRate.create({ data: { tenantId: lender.tenantId, basis: "REPO", effectiveDate: new Date(`${TODAY}T00:00:00Z`), rate: "0.07", source: "SARB_FEED" } })

    const { applicationId } = await createApplication(db, lender, { amount: 2_000_000, termDays: 360 })
    // tomorrow, before the 00:10 job (or any night it fails): LoanProduct is still 2%
    const g = await gates(lender, applicationId, TOMORROW)
    expect(g.application.product.interestRatePm).toBe(0.02)
    expect(g.capCheck.ok).toBe(true)
    expect(g.terms.interestRatePm).toBe(0.0239)
    expect(g.terms.versioned?.pricingRuleId).toBeNull()
    expect(await checkNcaInterestRateFor(prisma, lender.tenantId, { creditType: "UNSECURED", interestRatePm: 0.0239, interestModel: "REDUCING_BALANCE" })).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
    // with no rule, the cap on the version's own rate refuses the approval
    expect(g.versionedCap).toMatchObject({ ok: false, reason: "ABOVE_CAP" })

    // and the nightly job does not write the over-cap rate through to LoanProduct (the portal and quotes advertise it): it blocks the version
    const night = await runWithTenant(lender.tenantId, () => prisma.$transaction((tx) => activateDueVersions(tx as never, lender.tenantId, TOMORROW, null)))
    expect(night.activated).toEqual([])
    expect(night.blocked).toEqual([expect.objectContaining({ version: 2, issues: [expect.stringContaining("exceeds the NCA maximum")] })])
    expect((await db.loanProduct.findUniqueOrThrow({ where: { id: lender.productId } })).interestRatePm).toBe(0.02)
  })

  it("C. a version approved while the process is non-NCA keeps a WEEKLY BULLET structure that ZA approval never re-checks", async () => {
    const { lender, propose } = await setup({ minAmount: 100_000, maxAmount: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" })
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await propose(PRODUCT_VERSION_KIND, { productId: lender.productId, effectiveFrom: TODAY, reason: "LS structure", config: cfg({ interestModel: "FLAT", repayment: { frequency: "WEEKLY", structure: "BULLET", graceKind: "NONE", graceInstalments: 0 } }) })
    resetActiveJurisdiction() // back to ZA: NCA gates on
    const { applicationId } = await createApplication(db, lender, { amount: 300_000, termDays: 90 })
    const g = await gates(lender, applicationId, TODAY)
    expect(g.terms.repayment).toMatchObject({ frequency: "WEEKLY", structure: "BULLET" })
    // the NCA rules are held at approval too: a structure approved while the process was non-NCA is refused now
    expect(g.terms.ncaIssues).toEqual([expect.stringContaining("legal sign-off")])
  })
})
