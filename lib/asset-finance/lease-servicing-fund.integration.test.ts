/**
 * Real-Postgres proof of slice 3 C5–C7 through the real routes: a full-
 * maintenance lease's fund takes each invoiced rental's maintenance; claims
 * need a second, different approver above the threshold and are drawn from
 * the fund when paid (it may go negative); readings are monotonic; at the end
 * of the term a return is inspected and billed once (excess usage to the cent,
 * damage), the fund settled by its risk model (LENDER_RISK reported;
 * LESSEE_SETTLED deficit billed, surplus refunded), the asset returned to
 * stock and the lease closed once paid; no claim after it ends.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-fund.integration.test.ts
 */
import { monthEndClamps } from "./first-due.test-helpers"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { backdateLease, leaseDocument, leaseRoutes, payAllOwed } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"
import { fundBalance } from "./maintenance-fund"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
// Not on the 29th to the 31st: the lease it books ends a day early there (monthEndClamps)
const suite = RUN && !monthEndClamps() ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans = { lenderRisk: "", deficit: "", surplus: "" }
const today = () => sastCalendarDate(new Date())
const daysAgo = (n: number) => fromDayNumber(toDayNumber(today()) - n)

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const routes = () => leaseRoutes(fx.host)
const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> })
const movements = (loanId: string) => database().maintenanceFundMovement.findMany({ where: { fund: { loanId } }, orderBy: { createdAt: "asc" } })

/** A 3-month FML (R4 500 maintenance, 1 500 h a year at R350 an hour over), booked and moved 3 months back: every rental due and invoiced. */
async function threeMonthFml(assetId: string, riskModel: "LENDER_RISK" | "LESSEE_SETTLED"): Promise<string> {
  const dealId = await approveLease(fx, staff, leaseBody(fx, {
    assetId, contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced, balloonCents: 100_000_000,
    preset: { kind: "MONTHLY", periods: 3 }, maintenanceRiskModel: riskModel, escalationRate: "0",
  }))
  await signLease(fx, database(), setSession, dealId)
  const loanId = await payoutAndBook(fx, database(), staff, dealId)
  await backdateLease(database(), loanId, 3)
  return loanId
}

async function extraAsset(n: number): Promise<string> {
  return (await database().financedAsset.create({
    data: {
      tenantId: fx.tenantId, assetClass: "EXCAVATOR", make: "TEST", model: `FML-${n}`, year: 2025, serialNumber: `TESTFML${t.toUpperCase()}${n}`,
      cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000, trackerId: `TRK-X${n}`, trackerProvider: "TEST Tracking", lenderNotedConfirmed: true, hours: 400,
    },
  })).id
}

suite.sequential("lease servicing: maintenance fund, claims, readings, return (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    loans.lenderRisk = await threeMonthFml(fx.assets[1], "LENDER_RISK")
    loans.deficit = await threeMonthFml(fx.assets[2], "LESSEE_SETTLED")
    loans.surplus = await threeMonthFml(await extraAsset(1), "LESSEE_SETTLED")
    expect((await runLeaseInvoiceBatch(database() as never, today())).ok).toBe(true)
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("C5: each invoiced rental's maintenance is contributed to the fund once", async () => {
    const m = await movements(loans.lenderRisk)
    expect(m.map((x) => [x.kind, x.amountCents])).toEqual([["CONTRIBUTION", 450_000], ["CONTRIBUTION", 450_000], ["CONTRIBUTION", 450_000]])
    expect(await database().maintenanceFundMovement.update({ where: { id: m[0].id }, data: { amountCents: 1 } }).catch((e: Error) => e.message)).toMatch(/immutable/)
  })

  it("C5: a claim at or above the threshold needs two different approvers; it is drawn from the fund when paid, and the fund may go negative", async () => {
    const doc = await leaseDocument(database(), fx, loans.lenderRisk)
    staff(fx.adminA, "LOAN_ADMIN")
    const submitted = await json(await routes().claim(loans.lenderRisk, { supplierId: fx.supplier, providerInvoiceDocumentId: doc, amountExclVatCents: 6_000_000, description: "Synthetic hydraulic pump replacement" }))
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    const claimId = String(submitted.body.claimId)
    expect((await routes().claimAction(loans.lenderRisk, claimId, "approve")).status).toBe(409) // the submitter
    staff(fx.adminB, "LOAN_ADMIN")
    expect((await json(await routes().claimAction(loans.lenderRisk, claimId, "approve"))).body.status).toBe("SUBMITTED") // first approval
    expect((await routes().claimAction(loans.lenderRisk, claimId, "approve")).status).toBe(409) // the same first approver
    expect(await database().$executeRawUnsafe(`UPDATE "MaintenanceClaim" SET "status" = 'APPROVED', "approvedById" = $2, "approvedAt" = now() WHERE "id" = $1`, claimId, fx.adminB)
      .catch((e: Error) => e.message)).toMatch(/MaintenanceClaim_four_eyes/)
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await routes().claimAction(loans.lenderRisk, claimId, "approve")).status).toBe(403) // no decide_asset_finance
    const third = await database().user.create({ data: { tenantId: fx.tenantId, email: `admin-c-${t}@staff.invalid`, password: "x", role: "LOAN_ADMIN" } })
    staff(third.id, "LOAN_ADMIN")
    expect((await json(await routes().claimAction(loans.lenderRisk, claimId, "approve"))).body.status).toBe("APPROVED")
    expect((await json(await routes().claimAction(loans.lenderRisk, claimId, "paid", { paymentReference: "SYNTH-EFT-77" }))).body.status).toBe("PAID")
    const m = await movements(loans.lenderRisk)
    expect(m.at(-1)).toMatchObject({ kind: "CLAIM", amountCents: 6_000_000, claimId })
    expect(fundBalance(m)).toBe(3 * 450_000 - 6_000_000)
  }, 60_000)

  it("C6: readings are monotonic per asset; the lessee's portal reading is today's", async () => {
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await json(await routes().reading(loans.lenderRisk, { readingDate: daysAgo(10), value: 900 }))).status).toBe(200)
    const lower = await json(await routes().reading(loans.lenderRisk, { readingDate: today(), value: 800 }))
    expect([lower.status, lower.body.reason]).toEqual([409, "not_monotonic"])
    setSession({ id: fx.director, email: fx.directorEmail, role: "CLIENT", tenantId: fx.tenantId }) // a director of the lessee entity
    expect((await routes().portalReading(loans.lenderRisk, { readingDate: daysAgo(1), value: 950 })).status).toBe(409)
    expect((await routes().portalReading(loans.lenderRisk, { readingDate: today(), value: 950 })).status).toBe(200)
    const asset = (await database().loan.findUniqueOrThrow({ where: { id: loans.lenderRisk } })).assetId ?? ""
    expect(await database().assetMeterReading.create({ data: { tenantId: fx.tenantId, assetId: asset, readingDate: dbDate(daysAgo(30)), value: 2_000, unit: "HOURS", source: "STAFF" } })
      .catch((e: Error) => e.message)).toMatch(/monotonic/)
  }, 60_000)

  it("C7 RETURN (LENDER_RISK): inspection, excess usage billed once to the cent with the damage, fund reported, asset returned, lease closed when paid", async () => {
    await payAllOwed(database(), fx, loans.lenderRisk)
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await json(await routes().endOfTerm(loans.lenderRisk, "elect", { outcome: "RETURN" }))).status).toBe(200)
    // 400 h at the start, 1 000 h at the return: 600 used against 1 500 × 3/12 = 375 allowed → 225 h × R350 = R78 750.
    const inspected = await json(await routes().endOfTerm(loans.lenderRisk, "inspection", {
      inspectedOn: today(), condition: "Synthetic: fair wear, bucket teeth worn", finalReading: 1_000, damage: [{ description: "Cracked cab window", amountExclVatCents: 1_200_000 }],
    }))
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200)
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await json(await routes().endOfTerm(loans.lenderRisk, "invoice"))).status).toBe(200)
    const end = await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.lenderRisk }, include: { taxInvoice: { include: { lines: true } } } })
    expect(end).toMatchObject({ status: "INVOICED", excessUsageCents: 7_875_000, fundSettlementCents: 0 })
    expect(end.taxInvoice?.lines.map((l) => l.exclVatCents).sort()).toEqual([1_200_000, 7_875_000])
    expect(end.taxInvoice?.totalInclVatCents).toBe(Math.round((7_875_000 + 1_200_000) * 1.15))
    const fund = await database().maintenanceFund.findUniqueOrThrow({ where: { loanId: loans.lenderRisk } })
    expect(fund.settledBalanceCents).toBe(3 * 450_000 - 6_000_000)
    expect((await movements(loans.lenderRisk)).some((m) => m.kind.startsWith("SETTLEMENT"))).toBe(false)
    expect((await database().financedAsset.findFirstOrThrow({ where: { loans: { some: { id: loans.lenderRisk } } } })).lessorStatus).toBe("RETURNED_TO_STOCK")
    expect((await routes().endOfTerm(loans.lenderRisk, "invoice")).status).toBe(409) // billed once
    expect((await database().loan.findUniqueOrThrow({ where: { id: loans.lenderRisk } })).status).toBe("ACTIVE")
    await payAllOwed(database(), fx, loans.lenderRisk)
    expect((await database().loan.findUniqueOrThrow({ where: { id: loans.lenderRisk } })).status).toBe("COMPLETED")
    expect((await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.lenderRisk } })).status).toBe("COMPLETED")
  }, 120_000)

  it("C5: no claim after the lease ends", async () => {
    staff(fx.adminA, "LOAN_ADMIN")
    const doc = await leaseDocument(database(), fx, loans.lenderRisk)
    const late = await json(await routes().claim(loans.lenderRisk, { supplierId: fx.supplier, providerInvoiceDocumentId: doc, amountExclVatCents: 10_000, description: "Synthetic late claim" }))
    expect(late.status).toBe(409)
  })

  it("C5 LESSEE_SETTLED deficit: billed to the lessee on the end-of-term invoice; the fund nets to nil", async () => {
    const doc = await leaseDocument(database(), fx, loans.deficit)
    staff(fx.adminA, "LOAN_ADMIN")
    const submitted = await json(await routes().claim(loans.deficit, { supplierId: fx.supplier, providerInvoiceDocumentId: doc, amountExclVatCents: 2_000_000, description: "Synthetic service" }))
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    const claimId = String(submitted.body.claimId)
    const again = await json(await routes().claim(loans.deficit, { supplierId: fx.supplier, providerInvoiceDocumentId: doc, amountExclVatCents: 2_000_000, description: "Synthetic service" }))
    expect([again.status, again.body.reason]).toEqual([409, "invoice_claimed"]) // one live claim per provider invoice
    staff(fx.adminB, "LOAN_ADMIN")
    const approved = await json(await routes().claimAction(loans.deficit, claimId, "approve"))
    expect([approved.status, approved.body.status]).toEqual([200, "APPROVED"]) // below R50 000: one approver
    const paid = await json(await routes().claimAction(loans.deficit, claimId, "paid", { paymentReference: "SYNTH-EFT-78" }))
    expect([paid.status, paid.body.status]).toEqual([200, "PAID"])
    await payAllOwed(database(), fx, loans.deficit)
    staff(fx.officer, "CREDIT_OFFICER")
    for (const [action, body] of [["elect", { outcome: "RETURN" }], ["inspection", { inspectedOn: today(), condition: "Synthetic: good", finalReading: 700, damage: [] }]] as const) {
      const step = await json(await routes().endOfTerm(loans.deficit, action, body))
      expect(step.status, `${action}: ${JSON.stringify(step.body)}`).toBe(200)
    }
    staff(fx.adminA, "LOAN_ADMIN")
    const invoiced = await json(await routes().endOfTerm(loans.deficit, "invoice"))
    expect(invoiced.status, JSON.stringify(invoiced.body)).toBe(200)
    const end = await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.deficit }, include: { taxInvoice: { include: { lines: true } } } })
    expect(end.fundSettlementCents).toBe(2_000_000 - 3 * 450_000)
    expect(end.taxInvoice?.lines.map((l) => [l.description.startsWith("Maintenance fund deficit"), l.exclVatCents])).toEqual([[true, 650_000]])
    const m = await movements(loans.deficit)
    expect(m.at(-1)).toMatchObject({ kind: "SETTLEMENT_BILLED", amountCents: 650_000, taxInvoiceId: end.taxInvoiceId })
    expect(fundBalance(m)).toBe(0)
  }, 120_000)

  it("C5 LESSEE_SETTLED surplus: refunded (recorded); nothing to bill, so the lease closes at once", async () => {
    await payAllOwed(database(), fx, loans.surplus)
    staff(fx.officer, "CREDIT_OFFICER")
    const elected = await json(await routes().endOfTerm(loans.surplus, "elect", { outcome: "RETURN" }))
    expect([elected.status, elected.body.status]).toEqual([200, "ELECTED"])
    const inspected = await json(await routes().endOfTerm(loans.surplus, "inspection", { inspectedOn: today(), condition: "Synthetic: good", finalReading: 500, damage: [] }))
    expect([inspected.status, inspected.body.status], JSON.stringify(inspected.body)).toEqual([200, "INSPECTED"])
    staff(fx.adminA, "LOAN_ADMIN")
    const invoiced = await json(await routes().endOfTerm(loans.surplus, "invoice"))
    expect([invoiced.status, invoiced.body.status], JSON.stringify(invoiced.body)).toEqual([200, "INVOICED"])
    const m = await movements(loans.surplus)
    expect(m.at(-1)).toMatchObject({ kind: "SETTLEMENT_REFUND", amountCents: 3 * 450_000 })
    expect(fundBalance(m)).toBe(0)
    const end = await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.surplus } })
    expect([end.status, end.taxInvoiceId]).toEqual(["COMPLETED", null])
    expect((await database().loan.findUniqueOrThrow({ where: { id: loans.surplus } })).status).toBe("COMPLETED")
  }, 120_000)
})
