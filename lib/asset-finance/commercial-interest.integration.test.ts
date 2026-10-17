import { randomUUID } from "node:crypto"
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

})
