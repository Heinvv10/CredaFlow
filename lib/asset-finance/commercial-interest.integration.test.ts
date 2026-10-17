import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { POST as cancellationRoute } from "@/app/api/asset-finance/loans/[loanId]/commercial-cancellation/route"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate } from "./dates"
import { newValuation, saleInvoice } from "./recovery.integration-fixture"
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
      const beforeShift = await load()
      const targetStart = new Date("2025-12-01T00:00:00+02:00")
      const shiftDays = Math.round((beforeShift.startDate.getTime() - targetStart.getTime()) / 86400000)
      await testSetup(db!,
        [`UPDATE "Loan" SET "startDate" = "startDate" - $2::int * INTERVAL '1 day', "maturityDate" = "maturityDate" - $2::int * INTERVAL '1 day' WHERE "id" = $1`, second.loanId, shiftDays],
        [`UPDATE "RepaymentSchedule" SET "dueDate" = "dueDate" - $2::int * INTERVAL '1 day' WHERE "loanId" = $1`, second.loanId, shiftDays],
        [`UPDATE "ContractRate" SET "effectiveDate" = "effectiveDate" - $2::int * INTERVAL '1 day' WHERE "loanId" = $1`, second.loanId, shiftDays])
      const original = await load()
      expect(original.totalInterest).toBeGreaterThan(0)
      // Independent period-day oracle: cancellation is January 1; possession
      // is February 1 and sale March 1. Neither later event earns more interest.
      const day = (date: Date) => Date.parse(sastCalendarDate(date)) / 86400000
      const oracleInterest = (on: string) => {
        const cutoff = Date.parse(on) / 86400000
        let previous = day(original.startDate)
        return original.repaymentSchedule.reduce((sum, row) => {
          const due = day(row.dueDate)
          const amount = due <= previous ? (cutoff >= due ? row.interestDue : 0)
            : Math.round(row.interestDue * Math.max(0, Math.min(1, (cutoff - previous) / (due - previous))))
          previous = due
          return sum + amount
        }, 0)
      }
      const earned = oracleInterest("2026-01-01")
      expect(oracleInterest("2026-03-01")).toBeGreaterThan(earned)
      expect(earned).toBeGreaterThan(0)
      expect(earned).toBeLessThan(original.totalInterest)
      const recoveryLoan: RecoveryLoan = { loanId: second.loanId, assetId: original.assetId!, regime: "NON_NCA", contractType: "INSTALMENT_SALE", borrowerKey: "TEST-CANCELLATION", entityId: original.entityId }
      const recoveryId = await newRecovery(db!, second, recoveryLoan, "NON_NCA_VOLUNTARY", { recoveredOn: dbDate("2026-02-01") })
      const proceeds = Math.floor(original.principal / 2)
      const valuationId = await newValuation(db!, second, recoveryLoan.assetId, proceeds - 10000, "ASSESSOR", today())
      await db!.recovery.update({ where: { id: recoveryId }, data: { status: "VALUED", valuationId } })
      await advance(db!, second, recoveryLoan, recoveryId, "LISTED")
      const recovery = await db!.recovery.findUniqueOrThrow({ where: { id: recoveryId } })
      session.current = { user: { id: second.officer, role: "CREDIT_OFFICER", email: `${second.officer}@test.invalid`, tenantId: second.tenantId } }
      const routes = saleRoutes(second.host)
      const proposed = await readJson(await routes.propose(recoveryId, saleBody(recovery.valuationId!, proceeds)))
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201)
      const saleId = proposed.body.id as string
      const missing = await readJson(await routes.completeSale(recoveryId, saleId, { completedOn: "2026-03-01" }))
      expect(missing.status).toBe(409)
      expect((await load()).commercialCancelledAt).toBeNull()
      const rawInvoice = await saleInvoice(db!, second, proceeds)
      await expect(db!.remarketingSale.update({ where: { id: saleId }, data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: rawInvoice } })).rejects.toThrow(/evidenced actual cancellation/)
      await expect(db!.loan.update({ where: { id: second.loanId }, data: { commercialCancelledAt: new Date("2026-01-01T00:00:00+02:00") } })).rejects.toThrow(/independently evidenced/)
      const evidence = await db!.entityDocument.create({ data: { tenantId: second.tenantId, entityId: original.entityId, dealId: second.dealId,
        docType: "LEGAL_DOCUMENT", fileName: "TEST-effective-cancellation-2026-01-01.pdf", mimeType: "application/pdf", fileSize: 1, storagePath: "/nonexistent/TEST-cancellation.pdf", contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: second.adminA } })
      const request = () => new NextRequest(`http://${second.host}/api/asset-finance/loans/${second.loanId}/commercial-cancellation`, { method: "POST", headers: { host: second.host, "content-type": "application/json" }, body: JSON.stringify({ cancelledOn: "2026-01-01", evidenceDocumentId: evidence.id, basis: "TEST verified written cancellation effective January 1", cancellationConfirmed: true }) })
      expect((await cancellationRoute(request(), { params: Promise.resolve({ loanId: second.loanId }) })).status).toBe(403)
      session.current = { user: { id: second.adminA, role: "LOAN_ADMIN", email: `${second.adminA}@test.invalid`, tenantId: second.tenantId } }
      const authorizedSession = session.current
      session.current = null
      expect((await cancellationRoute(request(), { params: Promise.resolve({ loanId: second.loanId }) })).status).toBe(401)
      session.current = { user: { ...authorizedSession!.user, tenantId: fx.tenantId } }
      expect((await cancellationRoute(request(), { params: Promise.resolve({ loanId: second.loanId }) })).status).toBe(403)
      session.current = { user: { ...authorizedSession!.user, totpEnrolmentRequired: true } } as typeof session.current
      expect((await cancellationRoute(request(), { params: Promise.resolve({ loanId: second.loanId }) })).status).toBe(403)
      expect(await db!.commercialCancellation.count({ where: { loanId: second.loanId } })).toBe(0)
      session.current = authorizedSession
      const recorded = await cancellationRoute(request(), { params: Promise.resolve({ loanId: second.loanId }) })
      expect(recorded.status, await recorded.text()).toBe(201)
      const cancelled = await load()
      expect(cancelled).toMatchObject({ commercialCancellationSaleId: null, totalInterest: earned, totalRepayable: original.principal + earned, contractualTotalInterest: original.totalInterest })
      const cancellation = await db!.commercialCancellation.findUniqueOrThrow({ where: { loanId: second.loanId } })
      expect(cancellation.cancelledOn.toISOString().slice(0, 10)).toBe("2026-01-01")
      await expect(db!.commercialCancellation.update({ where: { id: cancellation.id }, data: { cancelledOn: dbDate("2026-03-01") } })).rejects.toThrow(/immutable/)
      await expect(db!.commercialCancellation.delete({ where: { id: cancellation.id } })).rejects.toThrow(/immutable/)
      await expect(db!.entityDocument.update({ where: { id: evidence.id }, data: { deletedAt: new Date() } })).rejects.toThrow(/immutable/)
      session.current = { user: { id: second.officer, role: "CREDIT_OFFICER", email: `${second.officer}@test.invalid`, tenantId: second.tenantId } }
      const completed = await readJson(await routes.completeSale(recoveryId, saleId, { completedOn: "2026-03-01" }))
      expect(completed.status, JSON.stringify(completed.body)).toBe(200)
      expect((await load()).commercialCancelledAt?.toISOString()).toBe("2025-12-31T22:00:00.000Z")
      expect(cancelled.commercialCancelledAt).not.toBeNull()
      const rateCount = await db!.contractRate.count({ where: { loanId: second.loanId } })
      const rateResult = await db!.$transaction((tx) => repriceLoanForReference(tx as unknown as Parameters<typeof repriceLoanForReference>[0], { tenantId: second.tenantId, loanId: second.loanId, basis: "PRIME", effectiveDate: today(), runDate: today() }))
      expect(rateResult).toEqual({ kind: "not_eligible", reason: "contract_cancelled" })
      expect(await db!.contractRate.count({ where: { loanId: second.loanId } })).toBe(rateCount)
      expect(cancelled.repaymentSchedule.some((row) => row.commonLawContractualInterestDue !== null)).toBe(true)
      vi.useRealTimers()
      const applied = await readJson(await routes.proceeds(recoveryId))
      expect(applied.status, JSON.stringify(applied.body)).toBe(200)
      expect(applied.body).toMatchObject({ paymentCents: proceeds, shortfallCents: original.principal + earned - proceeds })
      const remaining = original.principal + earned - proceeds
      for (const at of [new Date(), new Date("2035-01-01")]) expect((await loanSettlementFigures(db! as unknown as ChargesTx, await load(), at)).totalToSettle).toBe(remaining)
      await expect(db!.repaymentSchedule.update({ where: { id: cancelled.repaymentSchedule[0].id }, data: { interestDue: cancelled.repaymentSchedule[0].interestDue + 1, totalDue: cancelled.repaymentSchedule[0].totalDue + 1 } })).rejects.toThrow(/cannot revive/)
      const cash = await applyManualReceipt(db! as unknown as PaymentDb, { tenantId: second.tenantId, loanId: second.loanId, amount: 10000, paymentMethod: "EFT", reference: original.reference, capturedById: second.adminA })
      expect((await loanSettlementFigures(db! as unknown as ChargesTx, await load(), new Date("2035-01-01"))).totalToSettle).toBe(remaining - 10000)
      session.current = { user: { id: second.adminA, role: "LOAN_ADMIN", email: `${second.adminA}@test.invalid`, tenantId: second.tenantId } }
      const reversed = await reverseReceipt(new NextRequest(`http://${second.host}/api/payments/${cash.payment.id}/reverse`, { method: "PATCH", headers: { host: second.host, "content-type": "application/json" }, body: JSON.stringify({ reason: "Synthetic returned EFT" }) }), { params: Promise.resolve({ id: cash.payment.id }) })
      expect(reversed.status, await reversed.text()).toBe(200)
      expect((await loanSettlementFigures(db! as unknown as ChargesTx, await load(), new Date("2035-01-01"))).totalToSettle).toBe(remaining)
      expect((await load()).commercialCancellationSaleId).toBe(saleId)
    } finally { vi.useRealTimers(); await cleanupRecoveryFixture(db!, second.tenantId) }
  }, 120000)

})
