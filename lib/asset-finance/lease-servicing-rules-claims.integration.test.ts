/**
 * Each clause of the slice 3 C5 maintenance fund and claim rules refuses its
 * attack, and is what refuses it: the same attack goes through with that one
 * clause (or rule) taken out, inside a rolled-back transaction. Nothing is
 * contributed, drawn, settled again, approved or paid on a settled fund (a
 * claim on it is only rejected); a billed deficit is on an invoice of the
 * fund's loan; a settlement movement settles its fund in the same
 * transaction; a fund is settled with no claim open; one live claim per
 * provider invoice; four-eyes, all three ways; a claim is submitted
 * unapproved, up to the lease's last day (or while it runs month to month),
 * on a supplier-invoice document; the transition matrix.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-rules-claims.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { backdateLease, leaseDocument, ruleAdmits, ruleRefuses } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loan: "", fund: "", doc: "", bankStatement: "", openRental: "", openMaintenance: 0 }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const today = () => sastCalendarDate(new Date())
const day = (offset: number) => fromDayNumber(toDayNumber(today()) + offset)
const C = "guardMaintenanceClaim"
const M = "guardMaintenanceFundMovement"

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const refuses = (rule: Parameters<typeof ruleRefuses>[1], message: RegExp, attack: (tx: Tx) => Promise<unknown>) => ruleRefuses(database(), rule, message, attack)
const without = (fn: string, clause: string, replacement = "") => ({ fn, replace: [clause, replacement] as const })

/** Test setup inside the attack's transaction: one statement with the triggers off. */
async function setup(tx: Tx, sql: string, ...params: unknown[]): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
  await tx.$executeRawUnsafe(sql, ...params)
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin")
}
const settledBehindTheGuards = (tx: Tx) => setup(tx, `UPDATE "MaintenanceFund" SET "settledAt" = now(), "settledBalanceCents" = 0 WHERE "id" = $1`, ids.fund)
const settle = (tx: Tx) => tx.maintenanceFund.update({ where: { id: ids.fund }, data: { settledAt: new Date(), settledBalanceCents: 0, settledById: fx.adminA } })

const claim = (tx: Tx, data: Record<string, unknown> = {}) => tx.maintenanceClaim.create({
  data: {
    tenantId: fx.tenantId, fundId: ids.fund, supplierId: fx.supplier, providerInvoiceDocumentId: ids.doc,
    amountExclVatCents: 100_000, description: "Synthetic: 500-hour service", submittedById: fx.officer, ...data,
  },
  select: { id: true },
})
const approve = (tx: Tx, id: string, by = fx.adminA) => tx.maintenanceClaim.update({ where: { id }, data: { status: "APPROVED", approvedById: by, approvedAt: new Date() } })
const firstApprove = (tx: Tx, id: string, by = fx.adminA) => tx.maintenanceClaim.update({ where: { id }, data: { firstApprovedById: by, firstApprovedAt: new Date() } })
const paidData = () => ({ status: "PAID" as const, paidById: fx.adminA, paidAt: new Date(), paymentReference: "EFT-SYNTH-9" })
const pay = (tx: Tx, id: string) => tx.maintenanceClaim.update({ where: { id }, data: paidData() })
const rejectedData = () => ({ status: "REJECTED" as const, rejectedById: fx.adminA, rejectedAt: new Date(), rejectionReason: "Synthetic: not covered" })
const reject = (tx: Tx, id: string) => tx.maintenanceClaim.update({ where: { id }, data: rejectedData() })
const movement = (tx: Tx, data: Record<string, unknown>) => tx.maintenanceFundMovement.create({
  data: { tenantId: fx.tenantId, fundId: ids.fund, occurredOn: dbDate(today()), kind: "SETTLEMENT_REFUND", amountCents: 1, ...data },
})
const claimMovement = (tx: Tx, claimId: string) => movement(tx, { kind: "CLAIM", claimId, amountCents: 100_000 })
const invoice = (tx: Tx, loanId: string | null) => issueTaxInvoice(tx as never, {
  tenantId: fx.tenantId, loanId, issueDate: today(), supplyDate: today(), createdById: fx.adminA,
  recipient: { name: "TEST Lessee (Pty) Ltd", address: "9 Synthetic Yard, Johannesburg, 2001", vatNumber: null },
  lines: [{ description: "Synthetic charge", quantity: 1, unitExclVatCents: 1_000 }],
})
/** An uninvoiced rental given a tax invoice behind the guards: a contribution would be due on it. */
async function invoicedOpenRental(tx: Tx): Promise<void> {
  await setup(tx, `UPDATE "LeaseRental" SET "taxInvoiceId" = $2 WHERE "id" = $1`, ids.openRental, (await invoice(tx, ids.loan)).id)
}
const contribution = (tx: Tx) => movement(tx, { kind: "CONTRIBUTION", leaseRentalId: ids.openRental, amountCents: ids.openMaintenance })

suite.sequential("lease servicing rules: maintenance fund and claims, clause by clause (each clause removed → the attack goes through)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    const dealId = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[1], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced, maintenanceRiskModel: "LESSEE_SETTLED",
    }))
    await signLease(fx, database(), setSession, dealId)
    ids.loan = await payoutAndBook(fx, database(), staff, dealId)
    await backdateLease(database(), ids.loan, 2)
    await runLeaseInvoiceBatch(database() as never, today())
    ids.fund = (await database().maintenanceFund.findUniqueOrThrow({ where: { loanId: ids.loan } })).id
    const rental = await database().leaseRental.findFirstOrThrow({ where: { loanId: ids.loan, periodNo: 6 } })
    ids.openRental = rental.id
    ids.openMaintenance = rental.maintenanceExclVatCents
    ids.doc = await leaseDocument(database(), fx, ids.loan)
    ids.bankStatement = (await database().entityDocument.create({
      data: {
        tenantId: fx.tenantId, entityId: fx.evidenced, dealId, docType: "BANK_STATEMENT", fileName: "bank_statement.pdf", mimeType: "application/pdf", fileSize: 1,
        storagePath: `/nonexistent/${dealId}-${randomUUID()}.pdf`, contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: fx.officer,
      },
    })).id
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("nothing is contributed, drawn or settled again on a settled fund", async () => {
    const BACKED = /must be backed by its rental, paid claim or a lessee-settled fund's settlement/
    await ruleAdmits(database(), async (tx) => { await invoicedOpenRental(tx); await contribution(tx) })
    await refuses(without(M, ` AND f."id" = NEW."fundId" AND f."settledAt" IS NULL`, ` AND f."id" = NEW."fundId"`), BACKED, async (tx) => {
      await invoicedOpenRental(tx)
      await settle(tx)
      await contribution(tx)
    })
    await refuses(without(M, ` AND c."tenantId" = NEW."tenantId" AND f."settledAt" IS NULL`, ` AND c."tenantId" = NEW."tenantId"`), BACKED, async (tx) => {
      const { id } = await claim(tx)
      await approve(tx, id)
      await pay(tx, id)
      await settle(tx) // a paid claim is not open
      await claimMovement(tx, id)
    })
    await refuses(without(M, `AND f."riskModel" = 'LESSEE_SETTLED' AND f."settledAt" IS NULL`, `AND f."riskModel" = 'LESSEE_SETTLED'`), BACKED,
      async (tx) => { await settle(tx); await movement(tx, {}) })
  })

  it("a billed deficit is on an invoice of the fund's loan; a settlement movement settles its fund in the same transaction", async () => {
    await refuses(without(M, `AND i."tenantId" = NEW."tenantId" AND i."loanId" = f."loanId"`, `AND i."tenantId" = NEW."tenantId"`), /must be backed/, async (tx) => {
      await movement(tx, { kind: "SETTLEMENT_BILLED", taxInvoiceId: (await invoice(tx, null)).id })
      await settle(tx)
    })
    await refuses({ table: "MaintenanceFundMovement", trigger: "MaintenanceFundMovement_settles_fund" }, /settles its fund in the same transaction/, (tx) => movement(tx, {}))
  })

  it("a fund is settled with no claim open", async () => {
    await refuses(without("guardMaintenanceFund", `IF EXISTS (SELECT 1 FROM "MaintenanceClaim" c`, `IF FALSE AND EXISTS (SELECT 1 FROM "MaintenanceClaim" c`),
      /settled with no claim open/, async (tx) => { await claim(tx); await settle(tx) })
  })

  it("a claim on a settled fund is only rejected: no approval, first approval or payment", async () => {
    const settled = without(C, `AND EXISTS (SELECT 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId" AND f."settledAt" IS NOT NULL) THEN`, "AND FALSE THEN")
    const ONLY = /claim on a settled fund is only rejected/
    await ruleAdmits(database(), async (tx) => { const { id } = await claim(tx); await settledBehindTheGuards(tx); await reject(tx, id) })
    await refuses(settled, ONLY, async (tx) => { const { id } = await claim(tx); await settledBehindTheGuards(tx); await approve(tx, id) })
    await refuses(settled, ONLY, async (tx) => { const { id } = await claim(tx, { amountExclVatCents: 5_000_000 }); await settledBehindTheGuards(tx); await firstApprove(tx, id) })
    await refuses(settled, ONLY, async (tx) => {
      const { id } = await claim(tx)
      await approve(tx, id)
      await settledBehindTheGuards(tx)
      await pay(tx, id)
      await setup(tx, `INSERT INTO "MaintenanceFundMovement" ("id", "tenantId", "fundId", "kind", "amountCents", "claimId", "occurredOn") VALUES ($1, $2, $3, 'CLAIM', 100000, $4, now()::date)`,
        randomUUID(), fx.tenantId, ids.fund, id)
    })
  })

  it("one live claim per provider invoice; a rejected claim frees it", async () => {
    await ruleAdmits(database(), async (tx) => { await reject(tx, (await claim(tx)).id); await claim(tx) })
    await refuses({ index: "MaintenanceClaim_one_per_invoice" }, /Unique constraint/, async (tx) => { await claim(tx); await claim(tx) })
  })

  it("four-eyes: the submitter neither approves nor first-approves; the two approvers are two people", async () => {
    const rule = { table: "MaintenanceClaim", constraint: "MaintenanceClaim_four_eyes" }
    await refuses(rule, /MaintenanceClaim_four_eyes/, async (tx) => approve(tx, (await claim(tx)).id, fx.officer))
    await refuses(rule, /MaintenanceClaim_four_eyes/, async (tx) => firstApprove(tx, (await claim(tx, { amountExclVatCents: 5_000_000 })).id, fx.officer))
    await refuses(rule, /MaintenanceClaim_four_eyes/, async (tx) => {
      const { id } = await claim(tx, { amountExclVatCents: 5_000_000 })
      await firstApprove(tx, id, fx.adminA)
      await approve(tx, id, fx.adminA)
    })
  })

  it("a claim is submitted unapproved, up to the lease's last day (or month to month after it), on a supplier invoice or other document", async () => {
    const endsOn = (iso: string) => (tx: Tx) => setup(tx, `UPDATE "MaintenanceFund" SET "leaseEndDate" = $2::date WHERE "id" = $1`, ids.fund, iso)
    await ruleAdmits(database(), async (tx) => { await endsOn(today())(tx); await claim(tx) })
    await refuses(without(C, `(today > fund."leaseEndDate" AND NOT fund.extending)`, "FALSE"), /No maintenance claim after the lease ends/,
      async (tx) => { await endsOn(day(-1))(tx); await claim(tx) })
    await ruleAdmits(database(), async (tx) => {
      await endsOn(day(-1))(tx)
      await tx.leaseEndOfTerm.create({ data: { tenantId: fx.tenantId, loanId: ids.loan, origin: "EXPIRY", outcome: "EXTEND", status: "EXTENDING", electedById: fx.officer } })
      await claim(tx)
    })
    await refuses(without(C, ` AND e."docType" IN ('SUPPLIER_INVOICE', 'OTHER')`), /provider invoice is a live document of its lease/,
      (tx) => claim(tx, { providerInvoiceDocumentId: ids.bankStatement }))
    await refuses(without(C, `IF NEW."status" <> 'SUBMITTED' OR NEW."firstApprovedById" IS NOT NULL THEN`, "IF FALSE THEN"), /submitted unapproved/,
      (tx) => claim(tx, { firstApprovedById: fx.adminA, firstApprovedAt: new Date() }))
  })

  it("the transition matrix: a submitted claim is approved before it is paid; an approved claim is not rejected", async () => {
    const matrix = without(C, `IF NOT ((OLD."status" = 'SUBMITTED'`, `IF FALSE AND NOT ((OLD."status" = 'SUBMITTED'`)
    await refuses(matrix, /cannot move from SUBMITTED to PAID/, async (tx) => {
      const { id } = await claim(tx)
      await tx.maintenanceClaim.update({ where: { id }, data: { ...paidData(), approvedById: fx.adminA, approvedAt: new Date() } })
      await claimMovement(tx, id)
    })
    await refuses(matrix, /cannot move from APPROVED to REJECTED/, async (tx) => {
      const { id } = await claim(tx)
      await approve(tx, id)
      await tx.maintenanceClaim.update({ where: { id }, data: { ...rejectedData(), approvedById: null, approvedAt: null } })
    })
  })
})
