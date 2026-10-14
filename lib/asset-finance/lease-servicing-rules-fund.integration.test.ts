/**
 * Each slice 3 C5–C6 database rule refuses its attack, and is what refuses
 * it: the same attack goes through with that one rule removed (inside a
 * rolled-back transaction). Maintenance fund, fund movements, claims and
 * meter readings.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-rules-fund.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { dbDate } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { backdateLease, leaseDocument, ruleRefuses } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loan: "", fund: "", invoicedRental: "", openRental: "", openMaintenance: 0, doc: "", asset: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const refuses = (rule: Parameters<typeof ruleRefuses>[1], message: RegExp, attack: (tx: Tx) => Promise<unknown>) => ruleRefuses(database(), rule, message, attack)

const claim = (tx: Tx, data: Partial<{ amountExclVatCents: number; description: string }> = {}) => tx.maintenanceClaim.create({
  data: {
    tenantId: fx.tenantId, fundId: ids.fund, supplierId: fx.supplier, providerInvoiceDocumentId: ids.doc,
    amountExclVatCents: 100_000, description: "Synthetic: 500-hour service", status: "SUBMITTED", submittedById: fx.officer, ...data,
  },
  select: { id: true },
})
const approve = (tx: Tx, id: string, by: string) => tx.maintenanceClaim.update({ where: { id }, data: { status: "APPROVED", approvedById: by, approvedAt: new Date() } })
const pay = (tx: Tx, id: string) => tx.maintenanceClaim.update({ where: { id }, data: { status: "PAID", paidById: fx.adminA, paidAt: new Date(), paymentReference: "EFT-SYNTH-1" } })
const movement = (tx: Tx, data: Record<string, unknown>) => tx.maintenanceFundMovement.create({
  data: { tenantId: fx.tenantId, fundId: ids.fund, occurredOn: dbDate(sastCalendarDate(new Date())), kind: "SETTLEMENT_REFUND", amountCents: 1, ...data },
})
const reading = (tx: Tx, readingDate: string, value: number) => tx.assetMeterReading.create({
  data: { tenantId: fx.tenantId, assetId: ids.asset, loanId: ids.loan, readingDate: dbDate(readingDate), value, unit: "HOURS", source: "STAFF", recordedById: fx.officer },
})

suite.sequential("lease servicing rules: fund, movements, claims, readings (each rule removed → the attack goes through)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    const dealId = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[1], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced, maintenanceRiskModel: "LESSEE_SETTLED",
    }))
    await signLease(fx, database(), setSession, dealId)
    ids.loan = await payoutAndBook(fx, database(), staff, dealId)
    await backdateLease(database(), ids.loan, 2)
    await runLeaseInvoiceBatch(database() as never, sastCalendarDate(new Date()))
    ids.fund = (await database().maintenanceFund.findUniqueOrThrow({ where: { loanId: ids.loan } })).id
    const rentals = await database().leaseRental.findMany({ where: { loanId: ids.loan }, orderBy: { periodNo: "asc" } })
    ids.invoicedRental = rentals[0].id
    ids.openRental = rentals[5].id
    ids.openMaintenance = rentals[5].maintenanceExclVatCents
    ids.doc = await leaseDocument(database(), fx, ids.loan)
    ids.asset = fx.assets[1]
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("MaintenanceFund_guard: a fund's risk model is fixed; it is never deleted", async () => {
    await refuses({ table: "MaintenanceFund", trigger: "MaintenanceFund_guard" }, /changes only by being settled/,
      (tx) => tx.maintenanceFund.update({ where: { id: ids.fund }, data: { riskModel: "LENDER_RISK" } }))
  })

  it("MaintenanceFundMovement_guard: a contribution is an invoiced rental's maintenance", async () => {
    await refuses({ table: "MaintenanceFundMovement", trigger: "MaintenanceFundMovement_guard" }, /must be backed/,
      (tx) => movement(tx, { kind: "CONTRIBUTION", leaseRentalId: ids.openRental, amountCents: ids.openMaintenance }))
  })

  it("MaintenanceFundMovement_shape: a settlement names no rental", async () => {
    await refuses({ table: "MaintenanceFundMovement", constraint: "MaintenanceFundMovement_shape" }, /MaintenanceFundMovement_shape/,
      (tx) => movement(tx, { leaseRentalId: ids.openRental }))
  })

  it("MaintenanceFundMovement_one_settlement: a fund is settled by one movement", async () => {
    await refuses({ index: "MaintenanceFundMovement_one_settlement" }, /Unique constraint/,
      async (tx) => { await movement(tx, {}); await movement(tx, {}) })
  })

  it("MaintenanceClaim_shape: a claim describes the work", async () => {
    await refuses({ table: "MaintenanceClaim", constraint: "MaintenanceClaim_shape" }, /MaintenanceClaim_shape/,
      (tx) => claim(tx, { description: "ab" }))
  })

  it("MaintenanceClaim_four_eyes: no one approves their own claim", async () => {
    await refuses({ table: "MaintenanceClaim", constraint: "MaintenanceClaim_four_eyes" }, /MaintenanceClaim_four_eyes/,
      async (tx) => approve(tx, (await claim(tx)).id, fx.officer))
  })

  it("MaintenanceClaim_guard: a claim's amount is fixed once submitted", async () => {
    await refuses({ table: "MaintenanceClaim", trigger: "MaintenanceClaim_guard" }, /are fixed/,
      async (tx) => tx.maintenanceClaim.update({ where: { id: (await claim(tx)).id }, data: { amountExclVatCents: 999_999 } }))
  })

  it("MaintenanceClaim_guard: a claim at or above the tenant's threshold needs two approvers", async () => {
    await refuses({ table: "MaintenanceClaim", trigger: "MaintenanceClaim_guard" }, /two approvers/,
      async (tx) => approve(tx, (await claim(tx, { amountExclVatCents: 5_000_000 })).id, fx.adminA))
  })

  it("MaintenanceClaim_paid_has_movement: a paid claim is drawn from its fund", async () => {
    await refuses({ table: "MaintenanceClaim", trigger: "MaintenanceClaim_paid_has_movement" }, /drawn from its fund/,
      async (tx) => { const { id } = await claim(tx); await approve(tx, id, fx.adminA); await pay(tx, id) })
  })

  it("AssetMeterReading_guard: a reading is never below an earlier one", async () => {
    await refuses({ table: "AssetMeterReading", trigger: "AssetMeterReading_guard" }, /monotonic/,
      (tx) => reading(tx, sastCalendarDate(new Date()), 1))
  })

  it("AssetMeterReading_value: a reading is not negative", async () => {
    await refuses({ table: "AssetMeterReading", constraint: "AssetMeterReading_value" }, /AssetMeterReading_value/,
      (tx) => reading(tx, "2000-01-03", -1))
  })
})
