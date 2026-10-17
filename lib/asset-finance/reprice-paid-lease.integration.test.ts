/** Real booked paid leases: late reference rates change funding snapshots,
 * while gross receipts, original tax supplies and maintenance stay intact. */
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
import { shiftLease } from "./lease-servicing.integration-fixture"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import { repriceLoanForReference } from "./reprice-loan"
import type { SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fixtures: LeaseFixture[] = []
suite.sequential("paid lease rate restatement uses rental-only funding cash", () => {
  afterAll(async () => {
    for (const fx of fixtures) {
      await cleanupLeaseRows(db, fx.tenantId).catch(() => undefined)
      await cleanupDealFixture(db, { tenantId: fx.tenantId }).catch(() => undefined)
    }
    await db.$disconnect()
  }, 60000)
  it.each([
    ["OPERATING_LEASE", -0.02],
    ["FULL_MAINTENANCE_LEASE", 0.02],
  ] as const)(
    "%s late rate %s preserves historical cash and tax",
    async (contractType, change) => {
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
          preset: { kind: "MONTHLY", periods: 12 },
          escalationRate: "0",
        })
      )
      await signLease(fx, db, setSession, deal)
      const loanId = await payoutAndBook(fx, db, staff, deal)
      await shiftLease(db, loanId, "2 months")
      const rows = await db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
      const receipt = (amount: number) =>
        applyManualReceipt(db as unknown as PaymentDb, {
          tenantId: fx.tenantId,
          loanId,
          amount,
          capturedById: fx.adminA,
        })
      await receipt(rows.slice(0, 2).reduce((sum, row) => sum + row.totalDue, 0))
      const today = sastCalendarDate(new Date()),
        effectiveDate = isoOfDbDate(rows[0].dueDate)
      const initial = await db.contractRate.findFirstOrThrow({ where: { loanId }, orderBy: { effectiveDate: "asc" } })
      const rate = new Prisma.Decimal(initial.resultingRate).add(change)
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
      const before = await db.loan.findUniqueOrThrow({
        where: { id: loanId },
        include: {
          payments: true,
          taxInvoices: true,
          leaseRentals: { orderBy: { periodNo: "asc" } },
          repaymentSchedule: { orderBy: { installmentNo: "asc" } },
        },
      })
      let capital = rows[0].assetFinanceOpeningBalanceCents!,
        prior = toDayNumber(sastCalendarDate(before.startDate))
      for (const rental of before.leaseRentals.slice(0, 2)) {
        const day = toDayNumber(isoOfDbDate(rental.dueDate))
        let rateDays = 0
        for (let d = prior + 1; d <= day; d++)
          rateDays += initial.resultingRate.toNumber() + (d >= toDayNumber(effectiveDate) ? change : 0)
        capital += Math.round((capital * rateDays) / 365) - rental.rentalExclVatCents
        prior = day
      }
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
      expect(after.leaseRentals.slice(0, 2)).toEqual(before.leaseRentals.slice(0, 2))
      expect(
        after.repaymentSchedule.slice(0, 2).map(({ assetFinanceOpeningBalanceCents: _opening, ...row }) => row)
      ).toEqual(
        before.repaymentSchedule.slice(0, 2).map(({ assetFinanceOpeningBalanceCents: _opening, ...row }) => row)
      )
      expect(after.repaymentSchedule[2].assetFinanceOpeningBalanceCents).toBe(capital)
      expect(after.leaseRentals.map((r) => r.maintenanceExclVatCents)).toEqual(
        before.leaseRentals.map((r) => r.maintenanceExclVatCents)
      )
      for (const rental of after.leaseRentals) {
        expect(rental.vatCents).toBe(
          Math.round(rental.rentalExclVatCents * 0.15) + Math.round(rental.maintenanceExclVatCents * 0.15)
        )
        expect(rental.totalCents).toBe(rental.rentalExclVatCents + rental.maintenanceExclVatCents + rental.vatCents)
      }
      expect(await db.assetFinanceRateCorrection.count({ where: { loanId } })).toBe(0)
    },
    120000
  )
})
