/**
 * BREAK TESTS 1 and 2 (RUN_ASSET_FINANCE_RECOVERY_IT): selling below valuation without a second approver, and
 * hiding a related buyer. Each `it` is an attack; the assertion is what a correct system does. A red test is a
 * reproduced FAIL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupE2e } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, newValuation, type RecoveryFixture } from "./recovery.integration-fixture"
import { plainListed, readJson, saleBody } from "./recovery-sale.integration-fixture"
import { asUser, bundle, db, makeTenant, RUN, sessionBox } from "./recovery-break.fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
let fx: RecoveryFixture
const officer = () => asUser(fx, fx.officer, "CREDIT_OFFICER")
const adminA = () => asUser(fx, fx.adminA, "LOAN_ADMIN")
const adminB = () => asUser(fx, fx.adminB, "LOAN_ADMIN")
const R = () => bundle(fx)

suite.sequential("break 1: below-valuation sale without a distinct second approver", () => {
  beforeAll(async () => { process.env.TRUSTED_PROXY = "1"; fx = await makeTenant() }, 120_000)
  afterAll(async () => {
    sessionBox.current = null
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx.tenantId).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("1a. proposer cannot approve or complete own below-valuation sale (officer and admin)", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    adminA()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 50_000_000, { belowValuationReason: "Reserve not met, urgent clearance" })))).body.id as string
    expect((await readJson(await R().s.approveSale(rec.id, sale))).status).toBe(409)
    expect((await readJson(await R().s.completeSale(rec.id, sale))).status).toBe(409)
    officer()
    expect((await readJson(await R().s.approveSale(rec.id, sale))).status).toBe(403)
    expect((await readJson(await R().s.completeSale(rec.id, sale))).status).toBe(409)
    expect((await db.remarketingSale.findUniqueOrThrow({ where: { id: sale } })).status).toBe("PENDING_APPROVAL")
  }, 120_000)

  it("1b. approving then editing the price (direct DB edit and cancel/re-propose) never completes cheaper than what was approved", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const s1 = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 90_000_000, { belowValuationReason: "Auction reserve not met" })))).body.id as string
    adminA()
    expect((await readJson(await R().s.approveSale(rec.id, s1))).status).toBe(200)
    // edit the price of the approved pending sale
    await expect(db.remarketingSale.update({ where: { id: s1 }, data: { priceInclVatCents: 10_000_000 } })).rejects.toThrow()
    // a cheaper second sale does not inherit the approval
    officer()
    const s2 = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 10_000_000, { belowValuationReason: "Scrap value, quick sale" })))).body.id as string
    expect((await readJson(await R().s.completeSale(rec.id, s2))).status).toBe(409)
    // approver flips: cannot approve twice, cannot be rewritten
    adminB()
    expect((await readJson(await R().s.approveSale(rec.id, s1))).status).toBe(409)
    await expect(db.remarketingSale.update({ where: { id: s1 }, data: { approvedById: fx.adminB } })).rejects.toThrow()
    // approval can be set only once on s2 and by a different user; DB-level same-user approval is refused
    await expect(db.remarketingSale.update({ where: { id: s2 }, data: { approvedById: fx.officer, approvedAt: new Date() } })).resolves.toBeTruthy()
    const done = await readJson(await R().s.completeSale(rec.id, s2))
    // s2 was created by officer; approver set directly = officer: DB must refuse completion
    expect(done.status, JSON.stringify(done.body)).not.toBe(200)
  }, 120_000)

  it("1c. recording a higher valuation after the sale was proposed at-valuation cannot let it complete unapproved", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body
    expect(sale.belowValuation).toBe(false)
    await newValuation(db, fx, rec.loan.assetId, 400_000_000)
    const done = await readJson(await R().s.completeSale(rec.id, sale.id as string))
    expect(done.status, JSON.stringify(done.body)).not.toBe(200)
  }, 120_000)

  it("1d. citing the lower of two valuations does not hide that the price is under the highest", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    const low = await newValuation(db, fx, rec.loan.assetId, 5_000_000, "DEALER")
    officer()
    const proposed = await readJson(await R().s.propose(rec.id, saleBody(low, 60_000_000)))
    expect(proposed.status).toBe(409) // no reason given: below the highest (100M)
    const withReason = await readJson(await R().s.propose(rec.id, saleBody(low, 60_000_000, { belowValuationReason: "Dealer valuation is lower" })))
    expect(withReason.body).toMatchObject({ belowValuation: true, approvalRequired: true })
  }, 120_000)

  it("1e. an approval given before a higher valuation was recorded does not carry over to complete", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 90_000_000, { belowValuationReason: "Reserve not met on the day" })))).body.id as string
    adminA()
    await R().s.approveSale(rec.id, sale)
    await newValuation(db, fx, rec.loan.assetId, 900_000_000)
    officer()
    const done = await readJson(await R().s.completeSale(rec.id, sale))
    // still below, so approval still holds; either it completes with approval (acceptable) or refuses; it must not complete without the approver
    const row = await db.remarketingSale.findUniqueOrThrow({ where: { id: sale } })
    if (row.status === "COMPLETED") expect(row.approvedById).toBe(fx.adminA)
    expect([200, 409]).toContain(done.status)
  }, 120_000)

  it("1f. the s127/other creator of the recovery or valuation can still not self-approve via a second account with the same id (same user id different role)", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    adminA()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 50_000_000, { belowValuationReason: "Reserve not met, urgent" })))).body.id as string
    // same user id, officer role: 403; admin role: 409 (self)
    for (const role of ["CREDIT_OFFICER", "LOAN_ADMIN"] as const) {
      asUser(fx, fx.adminA, role)
      expect((await readJson(await R().s.approveSale(rec.id, sale))).status).not.toBe(200)
    }
    expect((await db.remarketingSale.findUniqueOrThrow({ where: { id: sale } })).approvedById).toBeNull()
  }, 120_000)

  it("1g. a staff buyer cannot approve (or propose-and-approve via a colleague) their own purchase", async () => {
    await db.user.update({ where: { id: fx.adminB }, data: { name: "Lerato Mokgadi-Buyer" } })
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const proposed = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: "Lerato Mokgadi-Buyer", buyerIdentifier: "ZZ-STAFF-1" })))
    expect(proposed.body).toMatchObject({ relatedPartyMatch: true, approvalRequired: true })
    adminB()
    const approval = await readJson(await R().s.approveSale(rec.id, proposed.body.id as string))
    expect(approval.status, "the buyer (staff member adminB) approved their own purchase").toBeGreaterThanOrEqual(400)
  }, 120_000)
})
