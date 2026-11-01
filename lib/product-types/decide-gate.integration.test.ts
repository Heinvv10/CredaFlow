/**
 * The product types' gate through the real decide path (real Postgres, the approval matrix's fixture): an application on a new
 * type stops at it, says why, and moves on once its facts are set; whoever set them does not approve it.
 *
 *   RUN_APPROVAL_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/product-types/decide-gate.integration.test.ts
 */
import { afterEach, expect, it, vi } from "vitest"

const race = vi.hoisted(() => ({ passFirstCheck: false }))

vi.mock("@/lib/product-types/rules", async (importOriginal) => {
  const real = await importOriginal<typeof import("./rules")>()
  return {
    ...real,
    // A draw landing between the route's check and the transaction: the first check saw nothing wrong, the locked one reads the database.
    productTypeRefusal: (...args: Parameters<typeof real.productTypeRefusal>) => {
      if (!race.passFirstCheck) return real.productTypeRefusal(...args)
      race.passFirstCheck = false
      return Promise.resolve(null)
    },
  }
})
vi.mock("@/lib/prisma", async (importOriginal) => (await import("@/lib/approval/approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { A, app, approveAs, as, db, ids, inTenant, registerApprovalFixture, statusOf, suite, underReview } from "@/lib/approval/approval.integration-fixture"
import { verifyLockedCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { productTypeRefusal } from "./rules"

const retype = (productType: "SALARY_BACKED" | "MICRO") => db.loanProduct.update({ where: { id: ids.product }, data: { productType } })

suite("the product types at the decide route (real Postgres)", () => {
  registerApprovalFixture()
  afterEach(async () => {
    resetActiveJurisdiction()
    await retype("MICRO")
  })

  it("refuses a new type outright to an NCA lender", async () => {
    await retype("SALARY_BACKED")
    const id = A("pt-nca")
    await underReview(id, { amount: 300_000 })
    const result = await approveAs("la1", id)
    expect(result).toMatchObject({ status: 422, body: { productTypeRefused: true } })
    expect(String(result.body.error)).toContain("NCA lender")
  })

  it("outside the NCA stops a salary-backed application until its facts are there, and then lets it past this gate", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await retype("SALARY_BACKED")
    const id = A("pt-ls")
    await underReview(id, { amount: 300_000 })
    const refused = await approveAs("la1", id)
    expect(refused).toMatchObject({ status: 422, body: { productTypeRefused: true } })
    expect(String(refused.body.error)).toContain("employer")
    await db.applicationProductFacts.create({ data: { applicationId: id, tenantId: ids.tenant, employerName: "Maluti Mining", payrollNumber: "P-7", updatedById: ids.officer } })
    const past = await approveAs("la1", id)
    expect(past.body.productTypeRefused).toBeUndefined()
  })

  it("the check under the application's lock stands on its own: what changed after the route's check stops the approval", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await retype("SALARY_BACKED")
    const id = A("pt-race")
    await underReview(id, { amount: 300_000 })
    race.passFirstCheck = true
    const result = await approveAs("la1", id)
    expect(result.status).not.toBe(200)
    expect(await statusOf(id)).toBe("UNDER_REVIEW")
  })

  it("the check holds to the payout: an approval whose product type no longer passes is not paid out", async () => {
    const id = A("pt-payout")
    await underReview(id, { amount: 300_000 })
    expect((await approveAs("la1", id)).status).toBe(200)
    expect(await statusOf(id)).toBe("APPROVED")
    const verify = () => inTenant(() => app().$transaction((tx) => verifyLockedCurrentAffordabilityApproval(tx as never, { tenantId: ids.tenant, applicationId: id })))
    // This fixture has no payout-grade identity evidence, so an approval that passes the type check stops at the next one.
    expect(await verify()).toMatchObject({ ok: false, reason: "kyc_changed" })
    await retype("SALARY_BACKED")
    expect(await verify()).toMatchObject({ ok: false, reason: "changed" })
  })

  it("a draw approved and not paid out counts against the limit of the next", async () => {
    const id = A("pt-approved")
    await underReview(id, { amount: 300_000 })
    expect((await approveAs("la1", id)).status).toBe(200)
    await db.loanProduct.update({ where: { id: ids.product }, data: { productType: "REVOLVING" } })
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const clientId = `${id}-client`
    const next = (principalCents: number) => inTenant(() => productTypeRefusal(app() as never, ids.tenant, { id: "next", clientId, productId: ids.product, loanPurposeCategory: null, product: { productType: "REVOLVING" } }, { principalCents, limitCents: 500_000 }))
    expect(await next(200_001)).toContain("exceeds the revolving limit")
    expect(await next(200_000)).toBeNull()
    await db.loanProduct.update({ where: { id: ids.product }, data: { productType: "MICRO" } })
  })

  it("whoever changed the lending group does not approve its application", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await db.loanProduct.update({ where: { id: ids.product }, data: { productType: "GROUP" } })
    const id = A("pt-group")
    await underReview(id, { amount: 300_000 })
    const application = await db.loanApplication.findUniqueOrThrow({ where: { id } })
    const group = await db.borrowerGroup.create({ data: { tenantId: ids.tenant, name: `Group ${id}`, createdById: as.la2.id } })
    const other = await db.client.create({ data: { tenantId: ids.tenant, reference: `CLI-${id}-2`, idNumber: syntheticSaIdNumber(), firstName: "Synthetic", lastName: "Member", email: `${id}-2@test.invalid`, phone: "+27820000001" } })
    await db.borrowerGroupMember.createMany({ data: [application.clientId!, other.id].map((clientId) => ({ tenantId: ids.tenant, groupId: group.id, clientId, addedById: as.la2.id })) })
    await db.applicationProductFacts.create({ data: { applicationId: id, tenantId: ids.tenant, borrowerGroupId: group.id, updatedById: ids.officer } })
    await db.auditLog.create({ data: { tenantId: ids.tenant, userId: as.la1.id, userEmail: as.la1.email, action: "BORROWER_GROUP_MEMBERS_CHANGED", entity: "BorrowerGroup", entityId: group.id } })
    expect(await approveAs("la1", id)).toMatchObject({ status: 403, body: { pricingInputsSetByApprover: true } })
    expect((await approveAs("la2", id)).body.pricingInputsSetByApprover).toBeUndefined()
  })

  it("whoever set the facts does not approve the application", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await retype("SALARY_BACKED")
    const id = A("pt-sod")
    await underReview(id, { amount: 300_000 })
    await db.applicationProductFacts.create({ data: { applicationId: id, tenantId: ids.tenant, employerName: "Maluti Mining", payrollNumber: "P-7", updatedById: as.la1.id } })
    await db.auditLog.create({ data: { tenantId: ids.tenant, userId: as.la1.id, userEmail: as.la1.email, action: "APPLICATION_PRODUCT_FACTS_SET", entity: "LoanApplication", entityId: id } })
    const refused = await approveAs("la1", id)
    expect(refused).toMatchObject({ status: 403, body: { pricingInputsSetByApprover: true } })
  })
})
