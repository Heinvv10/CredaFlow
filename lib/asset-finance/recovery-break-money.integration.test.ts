/**
 * BREAK TEST 6 (RUN_ASSET_FINANCE_RECOVERY_IT): applying proceeds twice, creating two Payments, refunding twice,
 * refunding something other than the surplus, and other money-moving oddities.
 */
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PATCH as reversePayment } from "@/app/api/payments/[id]/reverse/route"
import { runRecoveryDeadlineSweep } from "./recovery-freeze-deadline"
import { cleanupE2e } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, day, type RecoveryFixture } from "./recovery.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { plainListed, readJson, refundForm, saleBody } from "./recovery-sale.integration-fixture"
import { asUser, bundle, db, makeTenant, RUN, sessionBox } from "./recovery-break.fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
let fx: RecoveryFixture
const officer = () => asUser(fx, fx.officer, "CREDIT_OFFICER")
const adminA = () => asUser(fx, fx.adminA, "LOAN_ADMIN")
const adminB = () => asUser(fx, fx.adminB, "LOAN_ADMIN")
const R = () => bundle(fx)

/** A fresh NCA s131 recovery taken through the routes to SURPLUS_HELD (price above settlement). */
async function surplusHeld() {
  const rec = await plainListed(db, fx, "NCA", 100_000_000)
  officer()
  const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 200_000_000)))).body.id as string
  expect((await readJson(await R().s.completeSale(rec.id, sale))).status).toBe(200)
  expect((await readJson(await R().s.proceeds(rec.id))).status).toBe(200)
  expect((await R().r.finalNotice(rec.id)).status).toBe(200)
  expect((await readJson(await R().s.outcome(rec.id))).body).toMatchObject({ status: "SURPLUS_HELD" })
  return rec
}

suite.sequential("break 6: double application and double refund", () => {
  beforeAll(async () => { process.env.TRUSTED_PROXY = "1"; fx = await makeTenant() }, 120_000)
  afterAll(async () => {
    sessionBox.current = null
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx.tenantId).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("6a. proceeds applied three times concurrently, then again, create exactly one Payment", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    const results = await Promise.all([1, 2, 3].map(async () => (await readJson(await R().s.proceeds(rec.id))).status))
    await R().s.proceeds(rec.id)
    await R().s.proceeds(rec.id, { receivedAt: new Date(Date.now() - 3600_000).toISOString() })
    expect(results.every((s) => s === 200 || s === 409 || s === 500), JSON.stringify(results)).toBe(true)
    expect(await db.payment.count({ where: { loanId: rec.loan.loanId } })).toBe(1)
    expect(await db.payment.count({ where: { loanId: rec.loan.loanId, amount: 100_000_000 } })).toBe(1)
  }, 120_000)

  it("6b. s127: the standalone surrender proceeds path cannot also credit a linked, sold recovery", async () => {
    const { id, surrenderId, loan } = await ladderRecovery(db, fx, true, "LISTED", {}, true)
    officer()
    const sale = (await readJson(await R().s.propose(id, saleBody((await db.recovery.findUniqueOrThrow({ where: { id } })).valuationId as string, 100_000_000)))).body.id as string
    await R().s.completeSale(id, sale)
    const before = await db.payment.count({ where: { loanId: loan.loanId } })
    const standalone = await R().r.surrenderProceeds(surrenderId as string, { saleProceedsCents: 100_000_000, receivedAt: new Date().toISOString() })
    expect(standalone.status, JSON.stringify(standalone.body)).toBeGreaterThanOrEqual(400)
    expect(await db.payment.count({ where: { loanId: loan.loanId } })).toBe(before)
  }, 120_000)

  it("6c. refund: second create, concurrent creates, creator approving, creator releasing, double release, wrong amount", async () => {
    const rec = await surplusHeld()
    officer()
    const created = await Promise.all([R().s.refund(rec.id, refundForm()), R().s.refund(rec.id, refundForm())].map(async (p) => (await readJson(await p)).status))
    expect(created.filter((s) => s === 201), JSON.stringify(created)).toHaveLength(1)
    expect(await db.recoveryRefund.count({ where: { recoveryId: rec.id } })).toBe(1)
    const refund = await db.recoveryRefund.findFirstOrThrow({ where: { recoveryId: rec.id } })
    const surplus = (await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).surplusCents
    expect(refund.amountCents).toBe(surplus)
    // creator cannot approve
    asUser(fx, fx.officer, "LOAN_ADMIN")
    expect((await readJson(await R().s.approveRefund(rec.id))).status).toBeGreaterThanOrEqual(400)
    // approve with admin A, concurrently twice
    adminA()
    const approvals = await Promise.all([R().s.approveRefund(rec.id), R().s.approveRefund(rec.id)].map(async (p) => (await readJson(await p)).status))
    expect(approvals.filter((s) => s === 200), JSON.stringify(approvals)).toHaveLength(1)
    // approver cannot release
    expect((await readJson(await R().s.releaseRefund(rec.id))).status).toBeGreaterThanOrEqual(400)
    // creator (officer user, promoted to admin role) releasing their own refund: three different people are claimed
    asUser(fx, fx.officer, "LOAN_ADMIN")
    const byCreator = await readJson(await R().s.releaseRefund(rec.id))
    expect(byCreator.status, "the creator released their own refund (only creator!=approver and approver!=releaser are enforced)").toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("6d. release by a third person closes it; a second release, a new refund and a wrong-amount refund are all refused", async () => {
    const rec = await surplusHeld()
    officer()
    await R().s.refund(rec.id, refundForm())
    adminA()
    await R().s.approveRefund(rec.id)
    adminB()
    const releases = await Promise.all([R().s.releaseRefund(rec.id), R().s.releaseRefund(rec.id)].map(async (p) => (await readJson(await p)).status))
    expect(releases.filter((s) => s === 200), JSON.stringify(releases)).toHaveLength(1)
    expect((await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("CLOSED")
    officer()
    expect((await readJson(await R().s.refund(rec.id, refundForm()))).status).toBeGreaterThanOrEqual(400)
    expect(await db.recoveryRefund.count({ where: { recoveryId: rec.id } })).toBe(1)
    // direct DB: a second refund row, a different amount
    await expect(db.recoveryRefund.create({ data: { tenantId: fx.tenantId, recoveryId: rec.id, amountCents: 1, accountHolder: "x", bankName: "x", branchCode: "1", accountNumber: "1", bankVerifiedById: fx.officer, bankVerificationDocumentId: (await db.recoveryRefund.findFirstOrThrow({ where: { recoveryId: rec.id } })).bankVerificationDocumentId, createdById: fx.officer } })).rejects.toThrow()
    await expect(db.recoveryRefund.updateMany({ where: { recoveryId: rec.id }, data: { amountCents: 999_999_999 } })).rejects.toThrow()
  }, 120_000)

  it("6e. a refund cannot be made for a shortfall recovery, nor for one whose surplus is 0", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    await R().s.proceeds(rec.id)
    await R().s.outcome(rec.id) // SHORTFALL_OPEN
    expect((await readJson(await R().s.refund(rec.id, refundForm()))).status).toBeGreaterThanOrEqual(400)
    expect(await db.recoveryRefund.count({ where: { recoveryId: rec.id } })).toBe(0)
  }, 120_000)

  it("6f. reversing the proceeds Payment (existing route) after a surplus is held must not leave a refundable surplus", async () => {
    const rec = await surplusHeld()
    const payment = await db.payment.findFirstOrThrow({ where: { loanId: rec.loan.loanId } })
    adminA()
    const reversed = await reversePayment(new NextRequest(`http://${fx.host}/api/payments/${payment.id}/reverse`, {
      method: "PATCH", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify({ reason: "Receipt keyed against the wrong loan" }),
    }), { params: Promise.resolve({ id: payment.id }) })
    const status = reversed.status
    // either the reversal is refused for a recovery receipt (PASS) or the refund must now be refused
    if (status === 200) {
      officer()
      const refund = await readJson(await R().s.refund(rec.id, refundForm()))
      expect(refund.status, "payment reversed (loan reopened) yet the surplus refund was accepted").toBeGreaterThanOrEqual(400)
    } else {
      expect(status).toBeGreaterThanOrEqual(400)
    }
  }, 120_000)

  it("6g. two sales proposed on one recovery: completing both (concurrently) completes one and issues one tax invoice", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const s1 = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    const s2 = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 101_000_000, { buyerName: "Other Buyer", buyerIdentifier: "ZZ-OTHER-2" })))).body.id as string
    expect(s1 && s2).toBeTruthy()
    const before = await db.taxInvoice.count({ where: { tenantId: fx.tenantId } })
    const out = await Promise.all([R().s.completeSale(rec.id, s1), R().s.completeSale(rec.id, s2)].map(async (p) => (await readJson(await p)).status))
    expect(out.filter((s) => s === 200), JSON.stringify(out)).toHaveLength(1)
    expect(await db.remarketingSale.count({ where: { recoveryId: rec.id, status: "COMPLETED" } })).toBe(1)
    expect(await db.taxInvoice.count({ where: { tenantId: fx.tenantId } }) - before).toBe(1)
    expect(await db.recoveryVatEvent.count({ where: { recoveryId: rec.id } })).toBe(1)
  }, 120_000)

  it("6h. nothing here writes the loan off by itself: after the deadline sweep a shortfall loan is not WRITTEN_OFF and the NON_NCA loan has no NCA notice", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    await R().s.proceeds(rec.id)
    await R().s.outcome(rec.id)
    expect((await R().r.valuationNotice(rec.id)).status).toBe(409)
    expect((await R().r.finalNotice(rec.id)).status).toBe(409)
    expect((await R().r.document(rec.id, "valuation")).status).toBe(404)
    expect((await R().r.document(rec.id, "final")).status).toBe(404)
    await runRecoveryDeadlineSweep(day(400))
    const loan = await db.loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })
    expect(loan.status).not.toBe("WRITTEN_OFF")
    expect((await R().r.close(rec.id)).status).toBe(409)
  }, 120_000)
})
