/**
 * Real-Postgres proof of the product engine (migration 20261030010000_product_engine): a version or a pricing rule exists
 * only because a second person approved it and is exactly what they approved; versions never change; a version in effect
 * makes LoanProduct equal to it; a loan keeps the terms it was written on; an NCA lender is held to its caps.
 *
 *   RUN_PRODUCT_ENGINE_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/product-engine/product-engine.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { asChecker, asMaker, createLender, type Lender } from "@/lib/decisioning/decisioning.integration-fixture"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { sastCalendarDate } from "@/lib/date/sast"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { runWithTenant } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { activateDueVersions } from "./activate"
import { priceApplication } from "./resolve"
import { PRICING_RULE_KIND } from "./pricing"
import { PRODUCT_VERSION_KIND } from "./change-handlers"

const suite = process.env.RUN_PRODUCT_ENGINE_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const TODAY = sastCalendarDate(new Date())
const TOMORROW = sastCalendarDate(new Date(Date.now() + 86_400_000))
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
  throw new Error("expected a refusal")
}

const config = (over: Record<string, unknown> = {}) => ({
  minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE",
  initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.05, initiationFeeMaxCents: 100_000, monthlyServiceFeeCents: 6_900,
  repayment: null,
  collateral: [{ code: "PAYSLIP", description: "Latest payslip", required: true }],
  eligibility: { minAge: 18, maxAge: 65, minMonthlyIncomeCents: null, minEmploymentMonths: null },
  ...over,
})
const weekly = { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 2 }

suite("product engine (real Postgres)", () => {
  let lender: Lender
  let productId: string
  const as = <T>(fn: () => Promise<T>) => runWithTenant(lender.tenantId, fn)
  const propose = (payload: Record<string, unknown>, kind = PRODUCT_VERSION_KIND) =>
    as(async () => {
      const d = await createDraft({ tenantId: lender.tenantId, actor: asMaker(lender), kind, title: "Change", payload })
      return submit({ tenantId: lender.tenantId, actor: asMaker(lender), id: d.id })
    })
  const approveRequest = (id: string) => as(() => approve({ tenantId: lender.tenantId, actor: asChecker(lender), id }))
  const versionPayload = (over: Record<string, unknown> = {}, effectiveFrom = TODAY) => ({ productId, effectiveFrom, reason: "Repricing for the new quarter", config: config(), ...over })

  beforeAll(async () => {
    lender = await createLender(db)
    // a short-term product (an NCA short-term credit transaction needs no repo rate): the cap is 5% a month
    productId = (await db.loanProduct.create({ data: { tenantId: lender.tenantId, code: "PERS", name: "Personal", productType: "PERSONAL", minAmount: 100_000, maxAmount: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" } })).id
  })
  afterEach(() => resetActiveJurisdiction())
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("an approved version in effect today is created and makes LoanProduct equal to it, audited, in the approval's own transaction", async () => {
    const request = await propose(versionPayload({ config: config({ interestRatePm: 0.04, maxAmountCents: 700_000 }) }))
    await approveRequest(request.id)
    const version = await db.productVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId, productId, version: 1 } })
    expect(version).toMatchObject({ interestRatePm: 0.04, maxAmount: 700_000, frequency: null, structure: null, graceKind: null, changeRequestId: request.id })
    expect(version.appliedAt).not.toBeNull()
    expect(await db.loanProduct.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ interestRatePm: 0.04, maxAmount: 700_000, monthlyServiceFee: 6_900 })
    const audits = await db.auditLog.findMany({ where: { tenantId: lender.tenantId, action: { in: ["PRODUCT_VERSION_CREATED", "PRODUCT_VERSION_ACTIVATED"] } }, select: { action: true } })
    expect(audits.map((a) => a.action).sort()).toEqual(["PRODUCT_VERSION_ACTIVATED", "PRODUCT_VERSION_CREATED"])
  })

  it("a version for a later day waits: LoanProduct is untouched until the night it takes effect, and the job skips a version superseded in the meantime", async () => {
    const future = await propose(versionPayload({ config: config({ interestRatePm: 0.035 }) }, TOMORROW))
    await approveRequest(future.id)
    const v2 = await db.productVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId, productId, version: 2 } })
    expect(v2.appliedAt).toBeNull()
    expect((await db.loanProduct.findUniqueOrThrow({ where: { id: productId } })).interestRatePm).toBe(0.04)
    // not due today
    expect(await as(() => prisma.$transaction((tx) => activateDueVersions(tx, lender.tenantId, TODAY, null)))).toEqual({ activated: [], blocked: [] })
    // due tomorrow
    const activated = await as(() => prisma.$transaction((tx) => activateDueVersions(tx, lender.tenantId, TOMORROW, null)))
    expect(activated.activated).toEqual([expect.objectContaining({ productId, version: 2, skipped: [] })])
    expect((await db.loanProduct.findUniqueOrThrow({ where: { id: productId } })).interestRatePm).toBe(0.035)
    // idempotent
    expect(await as(() => prisma.$transaction((tx) => activateDueVersions(tx, lender.tenantId, TOMORROW, null)))).toEqual({ activated: [], blocked: [] })
  })

  it("approval prices on the version in effect that day, and the one pricing rule that matches", async () => {
    // v2 starts tomorrow: today the application is priced on v1
    const today = await as(() => priceApplication(prisma, lender.tenantId, { productId, applicationId: "none", riskRank: null, termDays: 90, asOf: TODAY }))
    expect(today?.version.version).toBe(1)
    const tomorrow = await as(() => priceApplication(prisma, lender.tenantId, { productId, applicationId: "none", riskRank: null, termDays: 90, asOf: TOMORROW }))
    expect(tomorrow?.version.version).toBe(2)
    expect(await as(() => priceApplication(prisma, lender.tenantId, { productId, applicationId: "none", riskRank: null, termDays: 90, asOf: "2000-01-01" }))).toBeNull()
  })

  it("the version table refuses what no approved request made, anything that differs from it, any change and any delete", async () => {
    const v1 = await db.productVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId, productId, version: 1 } })
    const insert = (over: Record<string, unknown>) => db.productVersion.create({ data: { ...Object.fromEntries(Object.entries(v1).filter(([k]) => !["id", "createdAt", "appliedAt"].includes(k))), version: 9, effectiveFrom: new Date("2031-01-01"), ...over } as never })
    expect(await refusal(insert({ changeRequestId: "nope" }))).toContain("only by an approved PRODUCT_VERSION")
    expect(await refusal(insert({ changeRequestId: v1.changeRequestId, interestRatePm: 0.01 }))).toContain("must equal the approved")
    expect(await refusal(db.productVersion.update({ where: { id: v1.id }, data: { interestRatePm: 0.01 } }))).toContain("never changes")
    expect(await refusal(db.productVersion.delete({ where: { id: v1.id } }))).toContain("never changes")
    expect(await refusal(db.$executeRawUnsafe(`TRUNCATE "ProductVersion" CASCADE`))).toContain("never change")
    // the one write the activation makes is allowed, once
    expect(await refusal(db.productVersion.update({ where: { id: v1.id }, data: { appliedAt: new Date() } }))).toContain("never changes")
  })

  it("the version table refuses a repayment structure that contradicts itself, whatever wrote it", async () => {
    const base = { tenantId: lender.tenantId, productId, version: 50, effectiveFrom: new Date("2032-01-01"), minAmount: 1, maxAmount: 2, minTermDays: 1, maxTermDays: 2, interestRatePm: 0.01, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, collateral: [], eligibility: {}, reason: "test reason", changeRequestId: "x" }
    // The provenance trigger would answer first, so write behind the triggers (as a superuser can) to meet the CHECKs alone.
    const refused = async (over: Record<string, unknown>) => refusal(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      return tx.productVersion.create({ data: { ...base, ...over } as never })
    }))
    expect(await refused({ frequency: "WEEKLY" })).toContain("ProductVersion_repayment")
    expect(await refused({ frequency: "WEEKLY", structure: "BULLET", graceKind: "FULL", graceInstalments: 1 })).toContain("ProductVersion_repayment")
    expect(await refused({ frequency: "WEEKLY", structure: "INTEREST_ONLY", graceKind: "PRINCIPAL_ONLY", graceInstalments: 1 })).toContain("ProductVersion_repayment")
    expect(await refused({ frequency: "WEEKLY", structure: "AMORTISING", graceKind: "FULL", graceInstalments: 0 })).toContain("ProductVersion_repayment")
    expect(await refused({ interestModel: "DAILY_ACCRUAL", frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE" })).toContain("ProductVersion_repayment")
    expect(await refused({ minAmount: 5, maxAmount: 2 })).toContain("ProductVersion_numbers")
    expect(await refused({ interestRatePm: 1 })).toContain("ProductVersion_numbers")
  })

  it("the version table refuses two versions of a product on one day, or with one number, whatever wrote it", async () => {
    const row = (version: number, effectiveFrom: string) => ({ tenantId: lender.tenantId, productId, version, effectiveFrom: new Date(effectiveFrom), minAmount: 1, maxAmount: 2, minTermDays: 1, maxTermDays: 2, interestRatePm: 0.01, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, collateral: [], eligibility: {}, reason: "test reason", changeRequestId: "x" })
    const behindTriggers = (data: ReturnType<typeof row>) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      return tx.productVersion.create({ data: data as never })
    })
    await behindTriggers(row(60, "2033-01-01"))
    expect(await refusal(behindTriggers(row(61, "2033-01-01")))).toContain("effectiveFrom")
    expect(await refusal(behindTriggers(row(60, "2033-02-01")))).toContain("version")
  })

  it("an NCA lender may not approve any repayment structure, or a rate above the ceiling; a lender outside the NCA may approve the structure", async () => {
    await expect(propose(versionPayload({ config: config({ repayment: weekly }) }, "2031-03-01"))).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    await expect(propose(versionPayload({ config: config({ repayment: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 } }) }, "2031-03-01"))).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    await expect(propose(versionPayload({ config: config({ interestRatePm: 0.06 }) }, "2031-03-01"))).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    await expect(propose(versionPayload({ config: config({ monthlyServiceFeeCents: 7_000 }) }, "2031-03-01"))).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const lsWeekly = await propose(versionPayload({ config: config({ repayment: weekly, interestRatePm: 0.06 }) }, "2031-03-01"))
    await approveRequest(lsWeekly.id)
    const v = await db.productVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId, productId, effectiveFrom: new Date("2031-03-01") } })
    expect(v).toMatchObject({ frequency: "WEEKLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 2, interestRatePm: 0.06 })
  })

  it("two versions cannot take effect on the same day, and a draft against a version that has since moved is stale", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await expect(propose(versionPayload({}, "2031-03-01"))).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
    const a = await propose(versionPayload({}, "2031-06-01"))
    const b = await propose(versionPayload({ reason: "Another repricing of the product" }, "2031-07-01"))
    await approveRequest(a.id)
    await expect(approveRequest(b.id)).rejects.toMatchObject({ code: "STALE" })
  })

  it("a pricing rule exists only because an approved request made it, and is retired by another", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const create = await propose({
      action: "CREATE", rule: { productId, name: "Salaried, mobile, best grades", segment: "SALARIED", channel: "MOBILE", riskRankMin: 0, riskRankMax: 1, campaignCode: null, validFrom: TODAY, validTo: null, priority: 5, rate: { mode: "SET", value: 0.02 }, initiationFeePct: null },
    }, PRICING_RULE_KIND)
    await approveRequest(create.id)
    const rule = await db.productPricingRule.findFirstOrThrow({ where: { tenantId: lender.tenantId, changeRequestId: create.id } })
    expect(rule).toMatchObject({ name: "Salaried, mobile, best grades", rateMode: "SET", rateValue: 0.02, riskRankMin: 0, riskRankMax: 1, retiredAt: null })

    // priced: an application graded in the best band, salaried, on mobile
    const app = await db.loanApplication.create({ data: { tenantId: lender.tenantId, reference: `APP-PR-${Date.now()}`, clientId: (await db.client.create({ data: { tenantId: lender.tenantId, idNumber: `92${Date.now().toString().slice(-11)}`, firstName: "P", lastName: "R", email: `${Date.now()}@client.invalid`, phone: "0820000002" } })).id, productId, appliedAmount: 300_000, appliedTermDays: 84 } })
    await db.applicationPricingInput.create({ data: { applicationId: app.id, tenantId: lender.tenantId, segment: "SALARIED", channel: "MOBILE" } })
    const priced = await as(() => priceApplication(prisma, lender.tenantId, { productId, applicationId: app.id, riskRank: 1, termDays: 84, asOf: TODAY }))
    expect(priced?.pricing).toMatchObject({ ruleId: rule.id, ratePm: 0.02 })
    expect(priced?.base.ratePm).toBe(0.04)
    const worse = await as(() => priceApplication(prisma, lender.tenantId, { productId, applicationId: app.id, riskRank: 3, termDays: 84, asOf: TODAY }))
    expect(worse?.pricing.ruleId).toBeNull()

    // the table refuses a rule no request made, an edit, a delete; and a retirement without an approved request
    expect(await refusal(db.productPricingRule.create({ data: { tenantId: lender.tenantId, name: "x", rateMode: "SET", rateValue: 0.01, validFrom: new Date(TODAY), changeRequestId: "nope" } }))).toContain("only by an approved PRODUCT_PRICING_RULE")
    expect(await refusal(db.productPricingRule.update({ where: { id: rule.id }, data: { rateValue: 0.001 } }))).toContain("never changes")
    expect(await refusal(db.productPricingRule.update({ where: { id: rule.id }, data: { retiredAt: new Date(), retiredByRequestId: "nope" } }))).toContain("never changes")
    expect(await refusal(db.productPricingRule.delete({ where: { id: rule.id } }))).toContain("never changes")
    // one approved request makes one rule: the same rule again, from the same request, is refused
    const { id: _ruleId, createdAt: _ruleCreatedAt, retiredAt: _retiredAt, retiredByRequestId: _retiredBy, ...ruleCopy } = rule
    expect(await refusal(db.productPricingRule.create({ data: ruleCopy as never }))).toContain("changeRequestId")

    const retire = await propose({ action: "RETIRE", ruleId: rule.id }, PRICING_RULE_KIND)
    await approveRequest(retire.id)
    expect((await db.productPricingRule.findUniqueOrThrow({ where: { id: rule.id } })).retiredAt).not.toBeNull()
    expect((await as(() => priceApplication(prisma, lender.tenantId, { productId, applicationId: app.id, riskRank: 1, termDays: 84, asOf: TODAY })))?.pricing.ruleId).toBeNull()
    await expect(propose({ action: "RETIRE", ruleId: rule.id }, PRICING_RULE_KIND)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
  })

  it("an NCA lender's rule may not price above the ceiling: refused when proposed", async () => {
    await expect(propose({
      action: "CREATE", rule: { productId, name: "Too dear", segment: null, channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: TODAY, validTo: null, priority: 0, rate: { mode: "SET", value: 0.06 }, initiationFeePct: null },
    }, PRICING_RULE_KIND)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" })
  })

  it("a loan keeps the terms it was written on: appended in sequence, never changed or removed, and each names its version", async () => {
    const tenant = await createChargesTenant(db)
    const loan = await createChargesLoan(db, tenant)
    const own = await createChargesLoan(db, { tenantId: lender.tenantId, userId: lender.makerId, productId })
    const fresh = async () => (await createChargesLoan(db, { tenantId: lender.tenantId, userId: lender.makerId, productId })).loanId
    const v1 = await db.productVersion.findFirstOrThrow({ where: { tenantId: lender.tenantId, productId, version: 1 } })
    const terms = { loanId: own.loanId, tenantId: lender.tenantId, sequence: 1, productVersionId: v1.id, frequency: "WEEKLY" as const, structure: "AMORTISING" as const, graceKind: "NONE" as const, graceInstalments: 0, instalments: 12, baseRatePm: 0.04, interestRatePm: 0.04 }
    await db.loanTerms.create({ data: terms })
    // another lender's loan cannot take this lender's version (the composite foreign keys)
    expect(await refusal(db.loanTerms.create({ data: { ...terms, loanId: loan.loanId } }))).toBeTruthy()
    // a second row is the next number, so a restructure can record the terms from then on; any other number is refused
    expect(await refusal(db.loanTerms.create({ data: { ...terms, sequence: 3 } }))).toContain("next row for this loan is 2")
    expect(await refusal(db.loanTerms.create({ data: { ...terms, sequence: 1 } }))).toBeTruthy()
    await db.loanTerms.create({ data: { ...terms, sequence: 2, interestRatePm: 0.04, instalments: 24 } })
    expect(await db.loanTerms.count({ where: { loanId: own.loanId } })).toBe(2)
    expect(await refusal(db.loanTerms.update({ where: { tenantId_loanId_sequence: { tenantId: lender.tenantId, loanId: own.loanId, sequence: 1 } }, data: { interestRatePm: 0.01, baseRatePm: 0.01 } }))).toContain("never change")
    expect(await refusal(db.loanTerms.delete({ where: { tenantId_loanId_sequence: { tenantId: lender.tenantId, loanId: own.loanId, sequence: 2 } } }))).toContain("never change")
    expect(await refusal(db.loanTerms.create({ data: { ...terms, loanId: await fresh(), frequency: "WEEKLY", structure: "BULLET", graceKind: "FULL", graceInstalments: 1 } }))).toContain("LoanTerms_values")
    expect(await refusal(db.loanTerms.create({ data: { ...terms, loanId: await fresh(), interestRatePm: 0.01 } }))).toContain("LoanTerms_values")
    expect(await refusal(db.loanTerms.create({ data: { ...terms, loanId: await fresh(), deferredInterest: -1 } }))).toContain("LoanTerms_values")
  })

  it("a version cannot start in the past: the row must carry the day the approval gave it, today at the earliest", async () => {
    const request = await propose(versionPayload({ config: config({ interestRatePm: 0.031 }) }, "2031-05-01"))
    await approveRequest(request.id)
    const made = await db.productVersion.findFirstOrThrow({ where: { changeRequestId: request.id } })
    expect(sastCalendarDate(made.effectiveFrom)).toBe("2031-05-01")
    // the same row, a day earlier, is not the approved version: the day is held by the trigger (a past day starts today, never earlier)
    const { id: _id, createdAt: _createdAt, appliedAt: _appliedAt, ...copy } = made
    const yesterday = new Date(Date.now() - 2 * 86_400_000)
    expect(await refusal(db.productVersion.create({ data: { ...copy, version: 99, effectiveFrom: yesterday, collateral: [], eligibility: copy.eligibility as never } as never }))).toContain("must equal")
  })

  it("isolates lenders: another lender's versions and rules are invisible", async () => {
    const other = await createLender(db)
    expect(await runWithTenant(other.tenantId, async () => await prisma.productVersion.count())).toBe(0)
    expect(await runWithTenant(other.tenantId, async () => await prisma.productPricingRule.count())).toBe(0)
    expect(await runWithTenant(lender.tenantId, async () => await prisma.productVersion.count())).toBeGreaterThan(0)
  })
})
