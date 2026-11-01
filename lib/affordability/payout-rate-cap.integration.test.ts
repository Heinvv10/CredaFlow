/**
 * F10: a repo cut after an approval stops the payout of a product with NO version too (real Postgres). `frozenRateIsLawful` is the step of
 * the locked re-check every signing and payout route shares (verifyLockedCurrentAffordabilityApproval, wiring in current-approval.test.ts);
 * here it reads a real approval and real reference rates. Run with RUN_DB_IT=1 against a disposable database.
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApprovedPasqV3Application, type PasqV3Scenario } from "@/lib/compliance/pasq-v3-application.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { frozenRateIsLawful } from "./current-approval"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const PRICING = {
  principal: 2_000_000, termDays: 360, productType: "PERSONAL" as const, interestRatePm: 0.0239, interestModel: "REDUCING_BALANCE" as const,
  initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, initiationFeePayment: "DEFERRED" as const,
}

suite("the payout re-check holds an unversioned approval to the NCA cap (real Postgres)", () => {
  let a: PasqV3Scenario
  const lawful = async () => {
    const application = await db.loanApplication.findUniqueOrThrow({ where: { id: a.applicationId }, include: { product: true } })
    return runWithTenant(a.tenantId, () => prisma.$transaction((tx) => frozenRateIsLawful(tx as never, a.tenantId, application as never)))
  }

  beforeAll(async () => {
    a = await createApprovedPasqV3Application("repo-cut", "DECLINED", true, "DEFERRED", false, null, { pricing: PRICING }, "EFT")
    await db.user.create({ data: { id: `${a.tenantId}-rates`, tenantId: a.tenantId, email: `${a.tenantId}-rates@test.invalid`, password: "not-a-real-login", name: "Rates", role: "ADMIN" } })
    await db.user.create({ data: { id: `${a.tenantId}-rates2`, tenantId: a.tenantId, email: `${a.tenantId}-rates2@test.invalid`, password: "not-a-real-login", name: "Rates 2", role: "ADMIN" } })
    const repo = await db.referenceRate.create({ data: { tenantId: a.tenantId, basis: "REPO", effectiveDate: new Date("2026-01-01T00:00:00Z"), rate: "0.0775", requestedById: `${a.tenantId}-rates` } })
    await db.referenceRate.update({ where: { id: repo.id }, data: { status: "APPROVED", decidedById: `${a.tenantId}-rates2`, decidedAt: new Date() } })
  }, 90_000)
  afterAll(async () => { await db.$disconnect() })

  it("a SARB cut recorded after the approval makes the frozen rate unlawful; before it the rate passes", async () => {
    expect(await lawful()).toBe(true)
    // 7.75% -> 7%: the unsecured cap falls from 28.75% to 28% a year, under the 2.39% a month the approval froze.
    await db.referenceRate.create({ data: { tenantId: a.tenantId, basis: "REPO", effectiveDate: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`), rate: "0.07", source: "SARB_FEED" } })
    expect(await lawful()).toBe(false)
  })
})
