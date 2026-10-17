import { testSetup } from "./lease-servicing.integration-fixture"
/**
 * Slice 4a recovery, end to end: each of the four routes (s127 surrender, s131
 * attachment, NON_NCA voluntary, NON_NCA court order) is driven from the loan
 * to a closed recovery ONLY through the real route handlers, as the staff who
 * do each step. Fixture setup writes the booked loan, the section 129
 * notice record and the users; only valuation notice receipt dates are time-shifted to simulate the statutory waiting period. After every
 * write the suite asserts the recovery's status, the asset's lessorStatus, the
 * loan's status (never written off by the recovery), the Payment count and the
 * audit row. A shortfall closes only after two admins write the loan off
 * through the existing write-off route; a surplus closes through its refund.
 * The legal and tax rules are UNTESTED against the law.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-e2e.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { AssetLessorStatus, LoanStatus, RecoveryStatus } from "@prisma/client"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { toDayNumber } from "./dates"
import { legalRoutes, summonsBoundary } from "./legal-matter.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { answer, auditCount, bookE2eLoan, cleanupE2e, e2eRoutes, type Answer } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, s129Record, today, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
import { recoveryRoutes } from "./recovery-routes.integration-fixture"
import { refundForm, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
type Role = "CREDIT_OFFICER" | "LOAN_ADMIN"
const as = (id: string, role: Role) => { session.current = { user: { id, email: `${id}@e2e-it.test`, role, tenantId: fx.tenantId } } }
const officer = () => as(fx.officer, "CREDIT_OFFICER")
const adminA = () => as(fx.adminA, "LOAN_ADMIN")
const adminB = () => as(fx.adminB, "LOAN_ADMIN")
const r = () => recoveryRoutes(fx.host)
const s = () => saleRoutes(fx.host)
const l = () => legalRoutes(fx.host)
const e = () => e2eRoutes(fx.host)

const PRICE = 120_000_000
const TOWING = 500_000
const SHORTFALL_SETTLEMENT = 150_000_000
const SURPLUS_SETTLEMENT = 80_000_000
const boundary = summonsBoundary()

interface Run { loan: RecoveryLoan; id: string }
interface Expect { recovery: RecoveryStatus; lessor: AssetLessorStatus | null; payments: number; loan?: LoanStatus }

/** One write: the call answers as expected, and the audit log gains exactly one row of each action. */
async function write(actions: string[], call: () => Promise<Answer>, ok = 200): Promise<Answer> {
  const before = await Promise.all(actions.map((a) => auditCount(database(), fx.tenantId, a)))
  const answered = await call()
  expect(answered.status, JSON.stringify(answered.body)).toBe(ok)
  const after = await Promise.all(actions.map((a) => auditCount(database(), fx.tenantId, a)))
  actions.forEach((a, i) => expect(after[i] - before[i], `audit rows of ${a}`).toBe(1))
  return answered
}

/** The state after a step: the recovery, the asset, the loan (a recovery never writes it off by itself) and the receipts on it. */
async function expectState(run: Run, want: Expect): Promise<void> {
  const [recovery, asset, loan, payments] = await Promise.all([
    database().recovery.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } }),
    database().financedAsset.findUniqueOrThrow({ where: { id: run.loan.assetId }, select: { lessorStatus: true } }),
    database().loan.findUniqueOrThrow({ where: { id: run.loan.loanId }, select: { status: true } }),
    database().payment.count({ where: { loanId: run.loan.loanId } }),
  ])
  expect({ recovery: recovery.status, lessor: asset.lessorStatus, loan: loan.status, payments }).toEqual({ ...want, loan: want.loan ?? "ACTIVE" })
}

const sale = async (call: Promise<Response>): Promise<Answer> => answer(await call)

/** The cost flow: recorded PENDING by the officer, decided by an admin; the deduction (and a charged cost, and a rejected one) as given. */
async function costs(run: Run, charged: boolean): Promise<void> {
  const cost = (type: string, treatment: string, cents: number) => ({
    type, treatment, netCents: cents, vatCents: 0, supplierInvoiceRef: `INV-${randomUUID().slice(0, 6)}`, incurredOn: today(),
  })
  const record = async (body: ReturnType<typeof cost>) => {
    officer()
    return (await write(["ASSET_RECOVERY_COST_RECORDED"], () => r().cost(run.id, body), 201)).body.id as string
  }
  const decide = async (costId: string, decision: "APPROVED" | "REJECTED") => {
    adminA()
    await write(["ASSET_RECOVERY_COST_DECIDED"], () => e().decideCost(run.id, costId, decision))
  }
  const towing = await record(cost("TOWING", "DEDUCT_FROM_PROCEEDS", TOWING))
  // the officer who recorded it has no say in it: deciding is the admins'
  officer()
  expect((await e().decideCost(run.id, towing, "APPROVED")).status).toBe(403)
  adminA()
  await decide(towing, "APPROVED")
  expect((await e().decideCost(run.id, towing, "REJECTED")).status).toBe(409)
  if (charged) {
    await decide(await record(cost("LEGAL_CONTRACTUAL", "CHARGE_TO_ACCOUNT", 200_000)), "APPROVED")
    await decide(await record(cost("STORAGE", "DEDUCT_FROM_PROCEEDS", 300_000)), "REJECTED")
  }
}

/** From LISTED to CLOSED: costs, the sale (approved when below valuation), the proceeds, the notice (NCA), the outcome and the close. */
async function sellAndClose(run: Run, o: { nca: boolean; surplus: boolean; below: boolean; selfValued?: boolean; charged?: boolean; label: string }): Promise<void> {
  const charged = o.charged ? 200_000 : 0
  const settlement = o.surplus ? SURPLUS_SETTLEMENT : SHORTFALL_SETTLEMENT
  await costs(run, !!o.charged)
  await expectState(run, { recovery: "LISTED", lessor: "RECOVERED", payments: 0 })

  officer()
  const valuationId = (await database().recovery.findUniqueOrThrow({ where: { id: run.id } })).valuationId as string
  const proposed = await write(["ASSET_REMARKETING_SALE_PROPOSED"], () => sale(s().propose(run.id, saleBody(valuationId, PRICE, o.below ? { belowValuationReason: "Auction reserve not met on the day" } : {}))), 201)
  // a sale needs a second approver when it is below valuation or when its proposer recorded the valuation it relies on
  const approval = o.below || !!o.selfValued
  expect(proposed.body).toMatchObject({ belowValuation: o.below, selfValued: !!o.selfValued, approvalRequired: approval })
  const saleId = proposed.body.id as string
  if (approval) {
    expect((await sale(s().completeSale(run.id, saleId))).status).toBe(409) // not approved yet
    adminA()
    await write(["ASSET_REMARKETING_SALE_APPROVED"], () => sale(s().approveSale(run.id, saleId)))
  }
  officer()
  await write(["ASSET_REMARKETING_SALE_COMPLETED", "ASSET_RECOVERY_VAT_EVENT_RECORDED"], () => sale(s().completeSale(run.id, saleId)))
  await expectState(run, { recovery: "SOLD", lessor: "SOLD_IN_REMARKETING", payments: 0 })
  expect(await database().recoveryVatEvent.count({ where: { recoveryId: run.id, kind: "REPOSSESSION_DEEMED_SUPPLY" } })).toBe(1)

  // a receipt is a payment: the officer holds record_payment; the sale is not paid out twice
  officer()
  const settled: Expect = { recovery: "PROCEEDS_APPLIED", lessor: "SOLD_IN_REMARKETING", payments: 1, loan: o.surplus ? "COMPLETED" : "ACTIVE" }
  await write(["ASSET_RECOVERY_PROCEEDS_APPLIED"], () => sale(s().proceeds(run.id)))
  await expectState(run, settled)
  const net = PRICE - TOWING
  const applied = await database().recovery.findUniqueOrThrow({ where: { id: run.id } })
  expect(applied).toMatchObject({
    settlementDueCents: settlement, grossProceedsCents: PRICE, deductedCostsCents: TOWING, chargedCostsCents: charged, netProceedsCents: net,
    shortfallCents: Math.max(0, settlement + charged - net), surplusCents: Math.max(0, net - settlement - charged),
  })
  expect((await database().payment.findFirstOrThrow({ where: { loanId: run.loan.loanId } })).amount).toBe(Math.min(net, settlement))
  expect((await sale(s().proceeds(run.id))).status).toBe(200) // repeating answers with the recorded result
  expect(await database().payment.count({ where: { loanId: run.loan.loanId } })).toBe(1)

  let status: RecoveryStatus = "PROCEEDS_APPLIED"
  if (o.nca) {
    await write(["ASSET_RECOVERY_FINAL_NOTICE_ISSUED"], () => r().finalNotice(run.id))
    status = "FINAL_NOTICE_ISSUED"
    await expectState(run, { ...settled, recovery: status })
  }
  officer()
  await write(["ASSET_RECOVERY_OUTCOME_SETTLED"], () => sale(s().outcome(run.id)))
  const open: Expect = { ...settled, recovery: o.surplus ? "SURPLUS_HELD" : "SHORTFALL_OPEN" }
  await expectState(run, open)

  if (o.surplus) {
    // the debtor is owed the surplus: two people and a third release it, which closes the recovery
    officer()
    await write(["ASSET_RECOVERY_REFUND_CREATED"], () => sale(s().refund(run.id, refundForm())), 201)
    adminA()
    await write(["ASSET_RECOVERY_REFUND_APPROVED"], () => sale(s().approveRefund(run.id)))
    expect(await database().recovery.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } })).toEqual({ status: "SURPLUS_HELD" })
    adminB()
    await write(["ASSET_RECOVERY_REFUND_RELEASED", "ASSET_RECOVERY_CLOSED"], () => sale(s().releaseRefund(run.id)))
  } else {
    // a shortfall does not write the loan off, and does not close until someone does
    officer()
    expect((await r().close(run.id)).status).toBe(409)
    await expectState(run, open)
    adminA()
    await write(["LOAN_STATUS_CHANGED"], () => e().writeOff(run.loan.loanId, { action: "request", reason: `Shortfall after repossession sale (${o.label})` }))
    expect((await database().loan.findUniqueOrThrow({ where: { id: run.loan.loanId } })).status).toBe("PENDING_WRITE_OFF")
    officer()
    expect((await r().close(run.id)).status).toBe(409) // a pending write-off is not a write-off
    adminA()
    expect((await e().writeOff(run.loan.loanId, { action: "approve", confirm: true })).status).toBe(422) // not by the requester
    adminB()
    await write(["LOAN_STATUS_CHANGED"], () => e().writeOff(run.loan.loanId, { action: "approve", confirm: true }))
    officer()
    await write(["ASSET_RECOVERY_CLOSED"], () => r().close(run.id))
  }
  await expectState(run, { recovery: "CLOSED", lessor: "SOLD_IN_REMARKETING", payments: 1, loan: o.surplus ? "COMPLETED" : "WRITTEN_OFF" })
  expect((await database().recovery.findUniqueOrThrow({ where: { id: run.id } })).closedAt).not.toBeNull()
}

/** Value, notify (NCA), list: the head every route shares once the recovery exists. The valuer is the admin B unless the proposer values it. */
async function valueAndList(run: Run, o: { nca: boolean; s131?: boolean; surrenderId?: string; valuationCents: number; valuedByProposer?: boolean }): Promise<void> {
  if (o.valuedByProposer) officer()
  else adminB()
  await expectState(run, { recovery: "RECOVERED", lessor: "RECOVERED", payments: 0 })
  const valuation = { valuedOn: today(), source: "ASSESSOR", valuerName: "TEST Valuers", amountCents: o.valuationCents }
  if (o.surrenderId) {
    await write(["ASSET_SURRENDER_VALUED"], () => r().surrenderValuation(o.surrenderId as string, valuation))
    await write(["ASSET_RECOVERY_VALUED"], () => r().valuation(run.id))
  } else {
    await write(["ASSET_RECOVERY_VALUED"], () => r().valuation(run.id, valuation))
  }
  await expectState(run, { recovery: "VALUED", lessor: "RECOVERED", payments: 0 })
  officer()
  if (o.nca) {
    if (o.surrenderId) await write(["ASSET_SURRENDER_VALUATION_NOTICE_ISSUED"], () => r().surrenderValuationNotice(o.surrenderId as string))
    await write(["ASSET_RECOVERY_VALUATION_NOTICE_ISSUED"], () => r().valuationNotice(run.id))
    await expectState(run, { recovery: "VALUATION_NOTICE_ISSUED", lessor: "RECOVERED", payments: 0 })
    expect((await r().document(run.id, "valuation")).status).toBe(200)
  } else {
    expect((await r().valuationNotice(run.id)).status).toBe(409) // a NON_NCA recovery issues no NCA notice
  }
  if (o.nca) {
    // Advance the fixture clock after delivery; the real listing route must enforce the window.
    await testSetup(database(), [`UPDATE "Recovery" SET "valuationNoticeIssuedOn"=CURRENT_DATE-30,"valuationNoticeReceivedOn"=CURRENT_DATE-30,"valuationReceiptReference"='Synthetic delivered notice; clock advanced' WHERE "id"=$1`,run.id])
    if(o.surrenderId) await testSetup(database(), [`UPDATE "SurrenderRequest" SET "valuationNoticeIssuedOn"=CURRENT_DATE-30,"valuationNoticeReceivedOn"=CURRENT_DATE-30,"valuationReceiptReference"='Synthetic delivered notice; clock advanced' WHERE "id"=$1`,o.surrenderId])
  }
  await write(["ASSET_RECOVERY_LISTED"], () => r().listForSale(run.id))
  await expectState(run, { recovery: "LISTED", lessor: "RECOVERED", payments: 0 })
}

const create = (loan: RecoveryLoan, body: Record<string, unknown>) =>
  write(["ASSET_RECOVERY_CREATED"], () => r().create(loan.loanId, { recoveredOn: today(), location: "TEST Yard", condition: "Synthetic: fair", ...body }), 201)

suite.sequential("recovery end to end: the four routes through the real handlers", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { bureauReportingStartDate: new Date("2020-01-01T00:00:00Z") } })
  }, 120_000)

  afterAll(async () => {
    session.current = null
    if (!db) return
    await cleanupE2e(db, recoveryFixtureTenantId(t)).catch(() => undefined)
    await cleanupRecoveryFixture(db, recoveryFixtureTenantId(t)).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("s127: surrender requested and valued on the surrender, recovered, sold to a shortfall, written off by two admins, closed", async () => {
    officer()
    const loan = await bookE2eLoan(database(), fx, "NCA", SHORTFALL_SETTLEMENT)
    const surrender = await write(["ASSET_SURRENDER_REQUESTED"], () => e().requestSurrender(loan.loanId, "Synthetic: running"), 201)
    const surrenderId = surrender.body.id as string
    expect(await database().financedAsset.findUniqueOrThrow({ where: { id: loan.assetId }, select: { lessorStatus: true } })).toEqual({ lessorStatus: null })
    const created = await create(loan, { route: "NCA_S127_SURRENDER", surrenderRequestId: surrenderId })
    const run = { loan, id: created.body.id as string }
    await valueAndList(run, { nca: true, surrenderId, valuationCents: 100_000_000 })
    await sellAndClose(run, { nca: true, surplus: false, below: false, label: "s127" })
    expect(await database().surrenderRequest.findUniqueOrThrow({ where: { id: surrenderId }, select: { status: true } })).toEqual({ status: "FINAL_NOTICE_ISSUED" })
  }, 240_000)

  it("s131: the legal matter to ASSET_RECOVERED, a below-valuation sale approved by an admin, a surplus refunded by three people, closed", async () => {
    officer()
    const loan = await bookE2eLoan(database(), fx, "NCA", SURPLUS_SETTLEMENT)
    // the notice was completed the day before it matured, so the s129 step may be dated on the matured day
    const notice = await s129Record(database(), fx, loan.loanId, "COMPLETED", toDayNumber(today()) - toDayNumber(boundary.matured) + 1)
    const matter = (await write(["LEGAL_MATTER_OPENED"], () => l().open(loan.loanId).then(answer), 201)).body.id as string
    const step = (body: Record<string, unknown>, ok = 201) => write(["LEGAL_MATTER_STEP_RECORDED"], () => l().step(matter, body).then(answer), ok)
    await step({ kind: "S129_SENT", stepDate: boundary.matured, section129RecordId: notice })
    expect(await l().step(matter, { kind: "SUMMONS_ISSUED", stepDate: boundary.matured }).then(answer)).toMatchObject({ status: 409 })
    await step({ kind: "SUMMONS_ISSUED", stepDate: boundary.summonsOn })
    await step({ kind: "SUMMONS_SERVED", stepDate: today() })
    await step({ kind: "JUDGMENT", stepDate: today() })
    await step({ kind: "ATTACHMENT_ORDER", stepDate: today() })
    expect(await database().financedAsset.findUniqueOrThrow({ where: { id: loan.assetId }, select: { lessorStatus: true } })).toEqual({ lessorStatus: null })
    const recovered = await write(["ASSET_RECOVERY_CREATED"], () => l().step(matter, { kind: "ASSET_RECOVERED", stepDate: today(), location: "TEST Yard", condition: "Synthetic: fair" }).then(answer), 201)
    // the step is audited too
    const run = { loan, id: recovered.body.recoveryId as string }
    expect(await database().recovery.findUniqueOrThrow({ where: { id: run.id }, select: { route: true, legalMatterId: true } })).toEqual({ route: "NCA_S131_ATTACHMENT", legalMatterId: matter })
    await valueAndList(run, { nca: true, valuationCents: 130_000_000 })
    await sellAndClose(run, { nca: true, surplus: true, below: true, label: "s131" })
  }, 240_000)

  it("NON_NCA voluntary: recovered, valued, listed with no NCA notice, sold with a charged cost to a shortfall, written off, closed", async () => {
    officer()
    const loan = await bookE2eLoan(database(), fx, "NON_NCA", SHORTFALL_SETTLEMENT)
    const created = await create(loan, { route: "NON_NCA_VOLUNTARY" })
    const run = { loan, id: created.body.id as string }
    await valueAndList(run, { nca: false, valuationCents: 100_000_000 })
    await sellAndClose(run, { nca: false, surplus: false, below: false, charged: true, label: "non-nca voluntary" })
  }, 240_000)

  it("NON_NCA court order: a judgment on the matter, ASSET_RECOVERED, sold to a surplus, refunded by three people, closed", async () => {
    officer()
    const loan = await bookE2eLoan(database(), fx, "NON_NCA", SURPLUS_SETTLEMENT)
    const matter = (await write(["LEGAL_MATTER_OPENED"], () => l().open(loan.loanId).then(answer), 201)).body.id as string
    const step = (body: Record<string, unknown>) => write(["LEGAL_MATTER_STEP_RECORDED"], () => l().step(matter, body).then(answer), 201)
    await step({ kind: "LETTER_OF_DEMAND", stepDate: today() })
    await step({ kind: "SUMMONS_ISSUED", stepDate: today() })
    expect((await l().step(matter, { kind: "ASSET_RECOVERED", stepDate: today(), location: "TEST Yard", condition: "Synthetic: fair" }).then(answer)).status).toBe(409) // no judgment yet
    await step({ kind: "JUDGMENT", stepDate: today() })
    const recovered = await write(["ASSET_RECOVERY_CREATED"], () => l().step(matter, { kind: "ASSET_RECOVERED", stepDate: today(), location: "TEST Yard", condition: "Synthetic: fair" }).then(answer), 201)
    const run = { loan, id: recovered.body.recoveryId as string }
    expect(await database().recovery.findUniqueOrThrow({ where: { id: run.id }, select: { route: true } })).toEqual({ route: "NON_NCA_COURT_ORDER" })
    await valueAndList(run, { nca: false, valuationCents: 100_000_000, valuedByProposer: true })
    await sellAndClose(run, { nca: false, surplus: true, below: false, selfValued: true, label: "non-nca court order" })
  }, 240_000)
})
