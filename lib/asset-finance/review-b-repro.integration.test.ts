/** Legal gaps 13, 14 and 25, through the real migrated ledger and tax-invoice service. Synthetic only. */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { quoteEarlyTermination, acceptEarlyTermination } from "./lease-termination-store"
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
suite.sequential("lease legal calculations applied to actual accounts", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    for (const assetId of fx.assets.slice(0, 4)) {
      const id = await approveLease(fx, staff, leaseBody(fx, { assetId, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", ...(assetId === fx.assets[3] ? { clientId: fx.lessee } : { entityId: fx.evidenced }) }))
      await signLease(fx, database(), setSession, id)
      loans.push(await payoutAndBook(fx, database(), staff, id))
    }
    const source = await database().financedAsset.findUniqueOrThrow({ where: { id: fx.assets[3] } })
    for (const label of ["PREPAID", "RECOVERY"]) {
      const asset = await database().financedAsset.create({ data: { ...source, id: undefined, serialNumber: `SYN-${label}-${t}`, vin: null, registrationNumber: null, lessorStatus: null, releasedAt: null } })
      const deal = await approveLease(fx, staff, leaseBody(fx, { assetId: asset.id, contractType: label === "PREPAID" ? "FULL_MAINTENANCE_LEASE" : "OPERATING_LEASE", rentalTiming: "ARREARS", ...(label === "PREPAID" ? { clientId: fx.lessee, maintenanceRiskModel: "LESSEE_SETTLED" } : { entityId: fx.evidenced }) }))
      await signLease(fx, database(), setSession, deal)
      loans.push(await payoutAndBook(fx, database(), staff, deal))
    }

  }, 600_000)
  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)
  for (const [index, insurance] of [[0, 0], [1, 100_000]]) {
    it(`fully prepaid total loss retains PV and accepts insurer cash (${insurance})`, async () => {
      const loanId = loans[index]
      const before = await database().loan.findUniqueOrThrow({ where: { id: loanId } })
      await applyManualReceipt(database() as unknown as PaymentDb, { tenantId: fx.tenantId, loanId, amount: before.totalRepayable, capturedById: fx.adminA, reference: "SYNTHETIC-REVIEW-PREPAID" })
      const result = await database().$transaction((tx) => recordLeaseTotalLoss(tx as never, { tenantId: fx.tenantId, userId: fx.adminA }, { loanId, today: today(), insuranceProceedsCents: insurance, evidence: "synthetic-writeoff.pdf" }))
      expect(result.kind).toBe("recorded")
      const quote = await database().leaseTerminationQuote.findFirstOrThrow({ where: { loanId } })
      expect(quote.pvCents).toBeGreaterThan(0)
      const payments = await database().payment.findMany({ where: { loanId, reversed: false } })
      expect(payments.reduce((sum, p) => sum + p.amount, 0)).toBe(before.totalRepayable + insurance)
      expect(payments.some((p) => p.allocationStatus === "UNAPPLIED")).toBe(true)
      const schedule = await database().repaymentSchedule.findMany({ where: { loanId } })
      expect(schedule.reduce((sum, row) => sum + row.totalDue, 0)).toBe(quote.totalCents)
      expect(schedule.reduce((sum, row) => sum + row.totalPaid, 0)).toBe(quote.totalCents)
    })
  }
  it("fully prepaid commercial acceptance retains future PV and offsets cash separately", async () => {
    const loanId = loans[2]
    const before = await database().loan.findUniqueOrThrow({ where: { id: loanId } })
    await applyManualReceipt(database() as unknown as PaymentDb, { tenantId: fx.tenantId, loanId, amount: before.totalRepayable, capturedById: fx.adminA, reference: "SYNTHETIC-PREPAID-COMMERCIAL" })
    const actor = { tenantId: fx.tenantId, userId: fx.adminA }
    const quote = await database().$transaction((tx) => quoteEarlyTermination(tx as never, actor, { loanId, today: today() }))
    expect(quote.kind).toBe("quoted")
    if (quote.kind !== "quoted") throw new Error(JSON.stringify(quote))
    const accepted = await database().$transaction((tx) => acceptEarlyTermination(tx as never, actor, { quoteId: quote.quoteId, today: today() }))
    expect(accepted.kind).toBe("accepted")
    const assessed = await database().leaseTerminationQuote.findUniqueOrThrow({ where: { id: quote.quoteId } })
    expect(assessed.pvCents).toBeGreaterThan(0)
    const payments = await database().payment.findMany({ where: { loanId, reversed: false } })
    expect(payments.reduce((sum, p) => sum + p.amount, 0)).toBe(before.totalRepayable)
    expect(payments.some((p) => p.allocationStatus === "UNAPPLIED")).toBe(true)
  })

})
