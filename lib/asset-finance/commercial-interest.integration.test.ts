import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PATCH as reverseReceipt } from "@/app/api/payments/[id]/reverse/route"
import { newRecovery, cleanupRecoveryFixture, today, type RecoveryLoan } from "./recovery.integration-fixture"
import { repriceLoanForReference } from "./reprice-loan"
import { advance } from "./recovery-path.integration-fixture"
import { saleRoutes, saleBody, readJson } from "./recovery-sale.integration-fixture"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { testSetup } from "./lease-servicing.integration-fixture"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import type { ChargesTx } from "@/lib/loan/charges-replay"
import { createBookedContractFixture, cleanupBookedContractFixture, type BookedContractFixture } from "./portal-contract.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const run = process.env.RUN_ASSET_FINANCE_COMMERCIAL_IT === "1"
const db = run ? new PrismaClient() : null
const suite = run ? describe : describe.skip
let fx: BookedContractFixture
suite("common-law in duplum persisted through the real Postgres charge replay", () => {
  beforeAll(async () => {
    fx = await createBookedContractFixture(db!, randomUUID().replaceAll("-", "").slice(0, 16), (user) => { session.current = user && { user } }, { dealAArrears: { margin: "0.4", feeCents: 0 } })
    await db!.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date() } })
  }, 120000)
  afterAll(async () => { if (db) { await cleanupBookedContractFixture(db, fx); await db.$disconnect() } })
  it("caps unpaid interest at capital and writes the capped charge to the ledger", async () => {
    const loan = await db!.loan.findUniqueOrThrow({ where: { id: fx.loanId } })
    await db!.$transaction(async (tx) => {
      await syncLoanCharges(tx as unknown as ChargesTx, { tenantId: fx.tenantId, loanId: fx.loanId }, new Date("2050-01-01"), { source: "commercial-legal-it", userId: fx.officer })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })
    const charges = await db!.loanCharge.findMany({ where: { loanId: fx.loanId, type: "DEFAULT_INTEREST" } })
    const after = await db!.loan.findUniqueOrThrow({ where: { id: fx.loanId } })
    const unpaidContractInterest = after.totalInterest
    expect(after.contractualTotalInterest).toBe(loan.totalInterest)
    const expectedDefaultInterest = loan.principal - unpaidContractInterest
    expect(expectedDefaultInterest).toBeGreaterThan(0)
    expect(charges.reduce((sum, row) => sum + row.amount, 0)).toBe(expectedDefaultInterest)
    expect(await db!.loan.findUniqueOrThrow({ where: { id: fx.loanId } })).toMatchObject({ chargesOutstanding: expectedDefaultInterest })
  })
  it("a real commercial early-settlement receipt removes future interest and closes the booked loan", async () => {
    const second = await createBookedContractFixture(db!, randomUUID().replaceAll("-", "").slice(0, 16), (user) => { session.current = user && { user } })
    try {
      const loan = await db!.loan.findUniqueOrThrow({ where: { id: second.loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
      const quote = await loanSettlementFigures(db! as unknown as ChargesTx, loan, new Date())
      expect(quote.totalToSettle).toBe(loan.principal)
      expect(quote.totalToSettle).toBeLessThan(loan.totalRepayable)
      await applyManualReceipt(db! as unknown as PaymentDb, { tenantId: second.tenantId, loanId: second.loanId,
        amount: quote.totalToSettle, paymentMethod: "EFT", reference: loan.reference, capturedById: second.adminA })
      expect(await db!.loan.findUniqueOrThrow({ where: { id: second.loanId } })).toMatchObject({ status: "COMPLETED", totalRepayable: loan.principal, totalInterest: 0 })
      const audit = await db!.auditLog.findFirst({ where: { tenantId: second.tenantId, action: "PAYMENT_RECORDED" }, orderBy: { createdAt: "desc" } })
      expect(audit?.newValue).toMatchObject({ earlyInstalmentSettlement: true })
    } finally { await cleanupBookedContractFixture(db!, second) }
  }, 120000)

  it("an actually booked ten-year agreement caps contractual interest with charges OFF and never resurrects blocked interest after a partial payment", async () => {
    const second = await createBookedContractFixture(db!, randomUUID().replaceAll("-", "").slice(0, 16), (user) => { session.current = user && { user } }, { dealAStructure: { periods: 120, rateMargin: "0.25" } })
    try {
      const booked = await db!.loan.findUniqueOrThrow({ where: { id: second.loanId } })
      expect(booked.totalInterest).toBeGreaterThan(booked.principal)
      // Move only the fixture clock relative to today; all money was booked
      // through real approval, signing, four-eyes payout and booking routes.
      await testSetup(db!,
        [`UPDATE "Loan" SET "startDate" = "startDate" - INTERVAL '15 years', "maturityDate" = "maturityDate" - INTERVAL '15 years' WHERE "id" = $1`, second.loanId],
        [`UPDATE "RepaymentSchedule" SET "dueDate" = "dueDate" - INTERVAL '15 years' WHERE "loanId" = $1`, second.loanId],
        [`UPDATE "ContractRate" SET "effectiveDate" = "effectiveDate" - INTERVAL '15 years' WHERE "loanId" = $1`, second.loanId])
      const load = () => db!.loan.findUniqueOrThrow({ where: { id: second.loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" as const } } } })
      const before = await load()
      const quote = await loanSettlementFigures(db! as unknown as ChargesTx, before, new Date())
      expect(quote.totalToSettle).toBe(2 * booked.principal)
      const firstPayment = Math.floor(booked.principal / 2)
      await applyManualReceipt(db! as unknown as PaymentDb, { tenantId: second.tenantId, loanId: second.loanId, amount: firstPayment, paymentMethod: "EFT", reference: booked.reference, capturedById: second.adminA })
      const partial = await load()
      expect(partial).toMatchObject({ totalInterest: booked.principal, contractualTotalInterest: booked.totalInterest, outstandingPrincipal: booked.principal })
      expect(partial.repaymentSchedule.some((row) => row.commonLawContractualInterestDue !== null)).toBe(true)
      const next = await loanSettlementFigures(db! as unknown as ChargesTx, partial, new Date())
      expect(next.totalToSettle).toBe(2 * booked.principal - firstPayment)
      await applyManualReceipt(db! as unknown as PaymentDb, { tenantId: second.tenantId, loanId: second.loanId, amount: next.totalToSettle, paymentMethod: "EFT", reference: booked.reference, capturedById: second.adminA })
      expect(await load()).toMatchObject({ status: "COMPLETED", totalInterest: booked.principal, totalRepayable: 2 * booked.principal, outstandingPrincipal: 0 })
    } finally { await cleanupBookedContractFixture(db!, second) }
  }, 120000)

  it("a real booked agreement crystallises on sale before partial proceeds, later quotes and receipt reversal", async () => {
    const second = await createBookedContractFixture(db!, randomUUID().replaceAll("-", "").slice(0, 16), (user) => { session.current = user && { user } })
    try {
      const load = () => db!.loan.findUniqueOrThrow({ where: { id: second.loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" as const } } } })
      const original = await load()
      expect(original.totalInterest).toBeGreaterThan(0)
      const recoveryLoan: RecoveryLoan = { loanId: second.loanId, assetId: original.assetId!, regime: "NON_NCA", contractType: "INSTALMENT_SALE", borrowerKey: "TEST-CANCELLATION", entityId: original.entityId }
      const recoveryId = await newRecovery(db!, second, recoveryLoan, "NON_NCA_VOLUNTARY")
      const proceeds = Math.floor(original.principal / 2)
      await advance(db!, second, recoveryLoan, recoveryId, "LISTED", { valuationCents: proceeds - 10000 })
      const recovery = await db!.recovery.findUniqueOrThrow({ where: { id: recoveryId } })
      session.current = { user: { id: second.officer, role: "CREDIT_OFFICER", email: `${second.officer}@test.invalid`, tenantId: second.tenantId } }
      const routes = saleRoutes(second.host)
      const proposed = await readJson(await routes.propose(recoveryId, saleBody(recovery.valuationId!, proceeds)))
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201)
      const saleId = proposed.body.id as string
      const completed = await readJson(await routes.completeSale(recoveryId, saleId, { completedOn: today() }))
      expect(completed.status, JSON.stringify(completed.body)).toBe(200)
      const cancelled = await load()
      expect(cancelled).toMatchObject({ commercialCancellationSaleId: saleId, totalInterest: 0, totalRepayable: original.principal, contractualTotalInterest: original.totalInterest })
      expect(cancelled.commercialCancelledAt).not.toBeNull()
      const rateCount = await db!.contractRate.count({ where: { loanId: second.loanId } })
      const rateResult = await db!.$transaction((tx) => repriceLoanForReference(tx as unknown as Parameters<typeof repriceLoanForReference>[0], { tenantId: second.tenantId, loanId: second.loanId, basis: "PRIME", effectiveDate: today(), runDate: today() }))
      expect(rateResult).toEqual({ kind: "not_eligible", reason: "contract_cancelled" })
      expect(await db!.contractRate.count({ where: { loanId: second.loanId } })).toBe(rateCount)
      expect(cancelled.repaymentSchedule.some((row) => row.commonLawContractualInterestDue !== null)).toBe(true)
      const applied = await readJson(await routes.proceeds(recoveryId))
      expect(applied.status, JSON.stringify(applied.body)).toBe(200)
      expect(applied.body).toMatchObject({ paymentCents: proceeds, shortfallCents: original.principal - proceeds })
      const remaining = original.principal - proceeds
      for (const at of [new Date(), new Date("2035-01-01")]) expect((await loanSettlementFigures(db! as unknown as ChargesTx, await load(), at)).totalToSettle).toBe(remaining)
      await expect(db!.repaymentSchedule.update({ where: { id: cancelled.repaymentSchedule[0].id }, data: { interestDue: cancelled.repaymentSchedule[0].interestDue + 1, totalDue: cancelled.repaymentSchedule[0].totalDue + 1 } })).rejects.toThrow(/cannot revive/)
      const cash = await applyManualReceipt(db! as unknown as PaymentDb, { tenantId: second.tenantId, loanId: second.loanId, amount: 10000, paymentMethod: "EFT", reference: original.reference, capturedById: second.adminA })
      expect((await loanSettlementFigures(db! as unknown as ChargesTx, await load(), new Date("2035-01-01"))).totalToSettle).toBe(remaining - 10000)
      session.current = { user: { id: second.adminA, role: "LOAN_ADMIN", email: `${second.adminA}@test.invalid`, tenantId: second.tenantId } }
      const reversed = await reverseReceipt(new NextRequest(`http://${second.host}/api/payments/${cash.payment.id}/reverse`, { method: "PATCH", headers: { host: second.host, "content-type": "application/json" }, body: JSON.stringify({ reason: "Synthetic returned EFT" }) }), { params: Promise.resolve({ id: cash.payment.id }) })
      expect(reversed.status, await reversed.text()).toBe(200)
      expect((await loanSettlementFigures(db! as unknown as ChargesTx, await load(), new Date("2035-01-01"))).totalToSettle).toBe(remaining)
      expect((await load()).commercialCancellationSaleId).toBe(saleId)
    } finally { await cleanupRecoveryFixture(db!, second.tenantId) }
  }, 120000)

})
