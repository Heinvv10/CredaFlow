/** Legal gaps 13, 14 and 25, through the real migrated ledger and tax-invoice service. Synthetic only. */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { backdateLease, testSetup, ruleRefuses } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { quoteEarlyTermination, acceptEarlyTermination } from "./lease-termination-store"
import { fundBalance } from "./maintenance-fund"
import { prepareLeaseRecoveryDamages } from "./lease-recovery-damages"
import { recordLeaseTotalLoss } from "./lease-total-loss"
import { issueLeaseRentalInvoice } from "./lease-invoices"
import { vatOnExclusive } from "@/lib/vat/amounts"

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
  it("uses supply-date VAT when the booked rate differs, keeping invoice, rental, schedule and loan totals equal", async () => {
    const id = loans[2]
    await backdateLease(database(), id, 1)
    const rental = await database().leaseRental.findFirstOrThrow({ where: { loanId: id }, orderBy: { periodNo: "asc" } })
    const fakeVat = vatOnExclusive(rental.rentalExclVatCents, 1600)
    const fakeTotal = rental.rentalExclVatCents + fakeVat
    const delta = fakeTotal - rental.totalCents
    await testSetup(database(),
      ['UPDATE "LeaseRental" SET "vatRate" = 0.16, "vatCents" = $2, "totalCents" = $3 WHERE "id" = $1', rental.id, fakeVat, fakeTotal],
      ['UPDATE "RepaymentSchedule" SET "principalDue" = $2, "totalDue" = $2 WHERE "id" = $1', rental.scheduleId, fakeTotal],
      ['UPDATE "Loan" SET "principal" = "principal" + $2, "totalRepayable" = "totalRepayable" + $2, "outstandingPrincipal" = "outstandingPrincipal" + $2 WHERE "id" = $1', id, delta])
    await applyManualReceipt(database() as unknown as PaymentDb, { tenantId: fx.tenantId, loanId: id, amount: fakeTotal, capturedById: fx.adminA, reference: "SYNTHETIC-VAT-DECREASE" })
    const result = await database().$transaction((tx) => issueLeaseRentalInvoice(tx as never, { tenantId: fx.tenantId, rentalId: rental.id, supplyDate: today(), today: today(), createdById: fx.adminA, source: "staff" }))
    expect(["issued", "already_invoiced"]).toContain(result.kind)
    const updated = await database().leaseRental.findUniqueOrThrow({ where: { id: rental.id }, include: { schedule: true, taxInvoice: true } })
    expect(Number(updated.vatRate)).toBe(0.15)
    expect(updated.totalCents).toBe(rental.totalCents)
    expect(updated.schedule.totalDue).toBe(updated.taxInvoice?.totalInclVatCents)
    expect(updated.schedule.totalPaid).toBeLessThanOrEqual(updated.schedule.totalDue)
  })
})
