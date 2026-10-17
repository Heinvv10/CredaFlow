/** Independent final edge probe: two real prepaid deposits plus excess insurance after OL/FML loss. Synthetic only. */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { recordLeaseTotalLoss } from "./lease-total-loss"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const db = RUN ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT required"); return db }
const suite = RUN ? describe : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans: string[] = []
const today = () => sastCalendarDate(new Date())
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
suite.sequential("independent final B cash conservation after fully prepaid loss", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    for (const [i, kind] of ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"].entries()) {
      const id = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[i], contractType: kind, rentalTiming: "ARREARS", entityId: fx.evidenced }))
      await signLease(fx, database(), setSession, id)
      loans.push(await payoutAndBook(fx, database(), staff, id))
    }

  }, 600_000)
  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it.each([0, 1])("retains two prepaid cash receipts and excess insurance separately from cancelled future consideration (%s)", async index => {
    const loanId = loans[index]
    const original = await database().loan.findUniqueOrThrow({ where: { id: loanId } })
    const first = Math.floor(original.totalRepayable / 2)
    for (const [n, amount] of [first, original.totalRepayable - first].entries()) {
      await applyManualReceipt(database() as unknown as PaymentDb, { tenantId: fx.tenantId, loanId, amount, capturedById: fx.adminA, reference: `SYN-PREPAID-${n}` })
    }
    expect((await database().loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe("COMPLETED")
    const insurance = original.totalRepayable + 137
    const input = { loanId, today: today(), insuranceProceedsCents: insurance, evidence: "synthetic-loss-with-prepayment.pdf" }
    const actor = { tenantId: fx.tenantId, userId: fx.adminA }
    const result = await database().$transaction(tx => recordLeaseTotalLoss(tx as never, actor, input), { timeout: 120000 })
    expect(result.kind).toBe("recorded")
    const rows = await database().repaymentSchedule.findMany({ where: { loanId } })
    const payments = await database().payment.findMany({ where: { loanId, reversed: false } })
    const owed = rows.reduce((sum, row) => sum + row.totalDue, 0)
    const cash = original.totalRepayable + insurance
    expect(payments.reduce((sum, row) => sum + row.amount, 0)).toBe(cash)
    expect(payments.filter(row => row.allocationStatus === "ALLOCATED").reduce((sum, row) => sum + row.amount, 0)).toBe(owed)
    expect(payments.filter(row => row.allocationStatus === "UNAPPLIED").reduce((sum, row) => sum + row.amount, 0)).toBe(cash - owed)
    expect(rows.reduce((sum, row) => sum + row.totalPaid, 0)).toBe(owed)
    expect(rows.every(row => row.totalPaid <= row.totalDue)).toBe(true)
    // Both independent deposits retain their own reference and full gross cash,
    // even where cancellation splits the first one into a refund-due child.
    for (const [n, expected] of [first, original.totalRepayable - first].entries()) {
      expect(payments.filter(row => row.reference === `SYN-PREPAID-${n}`).reduce((sum, row) => sum + row.amount, 0)).toBe(expected)
    }
    const before = await database().payment.count({ where: { loanId } })
    expect((await database().$transaction(tx => recordLeaseTotalLoss(tx as never, actor, input))).kind).toBe("refused")
    expect(await database().payment.count({ where: { loanId } })).toBe(before)
    expect(await database().leaseTerminationQuote.count({ where: { loanId, totalLoss: true } })).toBe(1)
  }, 120000)
})
