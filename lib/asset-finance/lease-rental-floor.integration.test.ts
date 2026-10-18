/** Actual-booked acceptance against the approved zero-rental constraint. */
import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { sastCalendarDate } from "@/lib/date/sast"
import {
  approveLease,
  cleanupLeaseRows,
  createLeaseFixture,
  leaseBody,
  payoutAndBook,
  signLease,
  type LeaseFixture,
} from "./lease.integration-fixture"
import { cleanupDealFixture } from "./deal.integration-fixture"
import { shiftLease, testSetup } from "./lease-servicing.integration-fixture"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import { billingRefusal } from "./lease-end-billing"
import { issueLeaseRentalInvoice } from "./lease-invoices"
import { repriceLoanForReference } from "./reprice-loan"
import type { SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fixtures: LeaseFixture[] = []
suite.sequential("large late lease cut floors future rent and retains the lessor residual", () => {
  afterAll(async () => {
    for (const fx of fixtures) {
      await cleanupLeaseRows(db, fx.tenantId).catch(() => undefined)
      await cleanupDealFixture(db, { tenantId: fx.tenantId }).catch(() => undefined)
    }
    await db.$disconnect()
  }, 60000)
  it.each([
    ["OPERATING_LEASE", 0.011, 1500],
    ["OPERATING_LEASE", 0.011, 1600],
    ["FULL_MAINTENANCE_LEASE", 0.011, 1500],
    ["FULL_MAINTENANCE_LEASE", 0.011, 1600],
  ] as const)(
    "%s late rate %s preserves historical cash and tax",
    async (contractType, change, bookedVat) => {
      process.env.TRUSTED_PROXY = "1"
      const fx = await createLeaseFixture(db, randomUUID().replaceAll("-", "").slice(0, 16))
      fixtures.push(fx)
      const setSession = (user: SessionUser | null) => {
        session.current = user && { user }
      }
      const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") =>
        setSession({ id, email: `${id}@synthetic.invalid`, role, tenantId: fx.tenantId })
      const deal = await approveLease(
        fx,
        staff,
        leaseBody(fx, {
          assetId: fx.assets[0],
          contractType,
          rentalTiming: "ARREARS",
          entityId: fx.evidenced,
          preset: { kind: "MONTHLY", periods: 60 },
          escalationRate: "0",
        })
      )
      await signLease(fx, db, setSession, deal)
      const loanId = await payoutAndBook(fx, db, staff, deal)
      await shiftLease(db, loanId, "59 months")
      const rows = await db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
      const receipt = (amount: number) =>
        applyManualReceipt(db as unknown as PaymentDb, {
          tenantId: fx.tenantId,
          loanId,
          amount,
          capturedById: fx.adminA,
        })
      await receipt(rows.slice(0, 59).reduce((sum, row) => sum + row.totalDue, 0))
      const today = sastCalendarDate(new Date()),
        effectiveDate = new Date(dbDate(isoOfDbDate(rows[0].dueDate)).getTime() + 86400000).toISOString().slice(0, 10)
      const initial = await db.contractRate.findFirstOrThrow({ where: { loanId }, orderBy: { effectiveDate: "asc" } })
      const rate = new Prisma.Decimal(change)
      const ref = await db.referenceRate.create({
        data: {
          tenantId: fx.tenantId,
          basis: "PRIME",
          effectiveDate: dbDate(effectiveDate),
          rate: rate.sub(initial.margin!),
          requestedById: fx.adminA,
        },
      })
      await db.referenceRate.update({
        where: { id: ref.id },
        data: { status: "APPROVED", decidedById: fx.adminB, decidedAt: new Date() },
      })
      if (bookedVat !== 1500) {
        const last = await db.leaseRental.findFirstOrThrow({ where: { loanId }, orderBy: { periodNo: "desc" } })
        const vat = Math.round(last.rentalExclVatCents * 0.16) + Math.round(last.maintenanceExclVatCents * 0.16),
          total = last.rentalExclVatCents + last.maintenanceExclVatCents + vat
        await testSetup(
          db,
          ['UPDATE "LeaseRental" SET "vatRate"=.16,"vatCents"=$2,"totalCents"=$3 WHERE "id"=$1', last.id, vat, total],
          ['UPDATE "RepaymentSchedule" SET "principalDue"=$2,"totalDue"=$2 WHERE "id"=$1', last.scheduleId, total],
          [
            'UPDATE "Loan" SET "principal"="principal"+$2,"totalRepayable"="totalRepayable"+$2,"outstandingPrincipal"="outstandingPrincipal"+$2 WHERE "id"=$1',
            loanId,
            total - last.totalCents,
          ]
        )
      }
      const before = await db.loan.findUniqueOrThrow({
        where: { id: loanId },
        include: {
          payments: true,
          taxInvoices: true,
          leaseRentals: { orderBy: { periodNo: "asc" } },
          repaymentSchedule: { orderBy: { installmentNo: "asc" } },
        },
      })
      const beforeAsset = await db.financedAsset.findUniqueOrThrow({ where: { id: fx.assets[0] } })
      expect(
        (
          await db.$transaction((tx) =>
            repriceLoanForReference(tx as never, {
              tenantId: fx.tenantId,
              loanId,
              basis: "PRIME",
              effectiveDate,
              runDate: today,
              actorUserId: fx.adminA,
            })
          )
        ).kind
      ).toBe("repriced")
      const after = await db.loan.findUniqueOrThrow({
        where: { id: loanId },
        include: {
          payments: true,
          taxInvoices: true,
          leaseRentals: { orderBy: { periodNo: "asc" } },
          repaymentSchedule: { orderBy: { installmentNo: "asc" } },
        },
      })
      expect(after.payments).toEqual(before.payments)
      expect(after.taxInvoices).toEqual(before.taxInvoices)
      expect(after.leaseRentals.slice(0, 59)).toEqual(before.leaseRentals.slice(0, 59))
      expect(after.leaseRentals.at(-1)!.rentalExclVatCents).toBe(0)
      expect(after.leaseRentals.map((row) => row.maintenanceExclVatCents)).toEqual(
        before.leaseRentals.map((row) => row.maintenanceExclVatCents)
      )
      const correction = await db.assetFinanceRateCorrection.findFirstOrThrow({
        where: { loanId, cause: { startsWith: "LEASE_FLOOR:" } },
      })
      const evidence = correction.contractualRows as {
        fundingAdjustments: Array<{ periodNo: number; capitalCashAdjustmentCents: number }>
        lessorRoundingCents: number
        retainedResidualCents: number
        endingCapitalCents: number
        taxDocuments: Array<{
          periodNo: number
          id: string
          invoiceId: string
          exclVatCents: number
          vatCents: number
          inclVatCents: number
        }>
      }
      expect(correction.amountCents).toBeLessThan(0)
      expect(correction.status).toBe("PENDING_MANUAL_EXECUTION")
      let capital = before.repaymentSchedule[0].assetFinanceOpeningBalanceCents!,
        previous = toDayNumber(sastCalendarDate(before.startDate))
      for (const [index, rental] of before.leaseRentals.entries()) {
        const day = toDayNumber(isoOfDbDate(rental.dueDate))
        let rateDays = 0
        for (let d = previous + 1; d <= day; d++)
          rateDays += d >= toDayNumber(effectiveDate) ? rate.toNumber() : initial.resultingRate.toNumber()
        const adjusted =
          index === 59
            ? 0
            : rental.rentalExclVatCents +
              (evidence.fundingAdjustments.find((part) => part.periodNo === rental.periodNo)
                ?.capitalCashAdjustmentCents ?? 0)
        capital += Math.round((Math.max(0, capital) * rateDays) / 365) - adjusted
        previous = day
      }
      expect(capital).toBe(evidence.endingCapitalCents)
      expect(capital).toBeLessThanOrEqual(evidence.retainedResidualCents)
      expect(evidence.retainedResidualCents).toBe(30_000_000)
      expect(evidence.lessorRoundingCents).toBe(evidence.retainedResidualCents - capital)
      for (const doc of evidence.taxDocuments) {
        const invoice = before.taxInvoices.find((invoice) => invoice.id === doc.invoiceId)!
        expect(invoice).toBeDefined()
        expect(Math.abs(doc.vatCents)).toBe(Math.round(Math.abs(doc.exclVatCents) * invoice.vatRate.toNumber()))
      }
      for (const adjustment of evidence.fundingAdjustments) {
        expect(
          evidence.taxDocuments
            .filter((doc) => doc.periodNo === adjustment.periodNo)
            .reduce((sum, doc) => sum + doc.exclVatCents, 0)
        ).toBe(adjustment.capitalCashAdjustmentCents)
      }
      expect(correction.amountCents).toBe(evidence.taxDocuments.reduce((sum, doc) => sum + doc.inclVatCents, 0))
      expect((await db.assetFinanceDeal.findFirstOrThrow({ where: { loanId } })).balloonCents).toBe(30_000_000)
      expect(await db.financedAsset.findUniqueOrThrow({ where: { id: fx.assets[0] } })).toEqual(beforeAsset)
      const retry = await db.$transaction((tx) =>
        repriceLoanForReference(tx as never, {
          tenantId: fx.tenantId,
          loanId,
          basis: "PRIME",
          effectiveDate,
          runDate: today,
          actorUserId: fx.adminA,
        })
      )
      expect(retry.kind).toBe("already_repriced")
      expect(
        await db.assetFinanceRateCorrection.count({ where: { loanId, cause: { startsWith: "LEASE_FLOOR:" } } })
      ).toBe(1)
      const last = after.leaseRentals.at(-1)!
      if (contractType === "OPERATING_LEASE") {
        const issued = await db.$transaction((tx) =>
          issueLeaseRentalInvoice(tx as never, {
            tenantId: fx.tenantId,
            rentalId: last.id,
            supplyDate: today,
            today,
            createdById: fx.adminA,
            source: "staff",
          })
        )
        expect(issued.kind).toBe("no_charge")
        // Real ORM boundary: zero consideration needs no invoice and cannot
        // permanently block a later honest end-of-term billing action.
        expect(await db.$transaction((tx) => billingRefusal(tx as never, {
          tenantId: fx.tenantId, loanId, today, actorUserId: fx.adminA,
          row: { outcome: "RETURN", assetId: fx.assets[0], purchaseValuationId: null, inspectedById: null, damageItems: [] },
        }))).toBeNull()
        expect(await db.taxInvoice.count({ where: { loanId } })).toBe(before.taxInvoices.length)
      } else {
        await receipt(last.totalCents)
        const supplied = await db.leaseRental.findUniqueOrThrow({
          where: { id: last.id },
          include: { taxInvoice: true },
        })
        expect(supplied.taxInvoice?.totalExclVatCents).toBe(last.maintenanceExclVatCents)
        expect(supplied.taxInvoice?.vatCents).toBe(Math.round(last.maintenanceExclVatCents * 0.15))
        expect(
          await db.maintenanceFundMovement.count({ where: { leaseRentalId: last.id, kind: "CONTRIBUTION" } })
        ).toBe(1)
      }
    },
    240000
  )
})
