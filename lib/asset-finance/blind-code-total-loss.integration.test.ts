/** Independent reviewer reproduction, extended to prove honest loss/fund closure. Synthetic only. */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { recordLeaseTotalLoss } from "./lease-total-loss"
import { invoiceEndOfTerm, completeEndOfTermIfSettled } from "./lease-end-invoice"
import { backdateLease, leaseDocument, payAllOwed, ruleRefuses } from "./lease-servicing.integration-fixture"
import { fundBalance } from "./maintenance-fund"
import { recordInspection } from "./lease-end-of-term"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const run = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const db = run ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("integration DB required"); return db }
const token = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const bookedLoans: string[] = []
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, role, email: `${id}@invalid.test`, tenantId: fx.tenantId })
;(run ? describe : describe.skip).sequential("blind code reviewer total-loss closure reproduction", () => {
  beforeAll(async () => { process.env.TRUSTED_PROXY = "1"; fx = await createLeaseFixture(database(), token) }, 120_000)
  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(token)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(token) })
    await db?.$disconnect()
  }, 60_000)
  for (const [index, risk] of [[0, null], [1, "LENDER_RISK"], [2, "LESSEE_SETTLED"]] as const) {
    it(`closes a paid ${risk ?? "operating"} loss without fabricated inspection, stock or cash`, async () => {
      const dealId = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[index], entityId: fx.evidenced,
        contractType: risk ? "FULL_MAINTENANCE_LEASE" : "OPERATING_LEASE", rentalTiming: "ARREARS", ...(risk ? { maintenanceRiskModel: risk } : {}) }))
      await signLease(fx, database(), setSession, dealId)
      const loanId = await payoutAndBook(fx, database(), staff, dealId)
      bookedLoans.push(loanId)
      const actor = { tenantId: fx.tenantId, userId: fx.adminA }
      const today = sastCalendarDate(new Date())
      if (risk) {
        await backdateLease(database(), loanId, 1)
        await payAllOwed(database(), fx, loanId) // Real cash invoices the rentals; future contributions are later credited.
      }
      const loss = await database().$transaction((tx) => recordLeaseTotalLoss(tx as never, actor, { loanId, today, insuranceProceedsCents: 0, evidence: "Synthetic unrecovered theft/write-off confirmation" }))
      expect(loss.kind).toBe("recorded")
      expect(await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId } })).toMatchObject({ outcome: "TOTAL_LOSS", status: "ELECTED" })
      expect(await database().$transaction((tx) => recordInspection(tx as never, actor, { loanId, today, inspectedOn: today, condition: "Invented inspection", finalReading: 500, damage: [] }))).toMatchObject({ kind: "refused", reason: "not_returnable" })
      await payAllOwed(database(), fx, loanId)
      const cashBefore = await database().payment.findMany({ where: { loanId }, orderBy: { id: "asc" } })
      let refund: { amountCents: number; paidOn: string; reference: string; documentId: string } | undefined
      const fundBefore = await database().maintenanceFund.findUnique({ where: { loanId }, include: { movements: true } })
      if (risk === "LESSEE_SETTLED") {
        const amountCents = fundBalance(fundBefore!.movements)
        expect(amountCents).toBeGreaterThan(0)
        expect(await database().$transaction((tx) => invoiceEndOfTerm(tx as never, actor, { loanId, today }))).toMatchObject({ kind: "refused", reason: "refund_evidence" })
        expect(await database().maintenanceFundMovement.count({ where: { fundId: fundBefore!.id, kind: "SETTLEMENT_REFUND" } })).toBe(0)
        const otherLeaseDocument = await leaseDocument(database(), fx, bookedLoans[0], "OTHER")
        const documentId = await leaseDocument(database(), fx, loanId, "OTHER")
        refund = { amountCents, paidOn: today, reference: `SYN-REFUND-${token}`, documentId }
        for (const invalid of [{ ...refund, amountCents: amountCents - 1 }, { ...refund, paidOn: "2999-01-01" }, { ...refund, documentId: otherLeaseDocument }]) {
          expect(await database().$transaction((tx) => invoiceEndOfTerm(tx as never, actor, { loanId, today, refund: invalid }))).toMatchObject({ kind: "refused", reason: "refund_evidence" })
        }
        await ruleRefuses(database(), { table: "MaintenanceFundMovement", trigger: "MaintenanceFundMovement_total_loss_refund_guard" }, /refund requires actual/, async (tx) => {
          await tx.maintenanceFundMovement.create({ data: { tenantId: fx.tenantId, fundId: fundBefore!.id, kind: "SETTLEMENT_REFUND", amountCents, occurredOn: new Date(today), createdById: fx.adminA } })
          await tx.maintenanceFund.update({ where: { id: fundBefore!.id }, data: { settledAt: new Date(), settledBalanceCents: amountCents, settledById: fx.adminA } })
        })
      }
      const billed = await database().$transaction((tx) => invoiceEndOfTerm(tx as never, actor, { loanId, today, refund }))
      expect(billed.kind, JSON.stringify(billed)).toBe("ok")
      expect(await database().$transaction((tx) => completeEndOfTermIfSettled(tx as never, { tenantId: fx.tenantId, loanId, userId: fx.adminA }))).toBe(false) // Already closed by billing.
      expect(await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId } })).toMatchObject({ status: "COMPLETED", outcome: "TOTAL_LOSS", inspectedOn: null, finalReadingId: null, excessUsageCents: null })
      expect(await database().financedAsset.findUniqueOrThrow({ where: { id: fx.assets[index] } })).toMatchObject({ lessorStatus: "TOTAL_LOSS" })
      expect(await database().payment.findMany({ where: { loanId }, orderBy: { id: "asc" } })).toEqual(cashBefore)
      if (fundBefore) {
        const fundAfter = await database().maintenanceFund.findUniqueOrThrow({ where: { loanId }, include: { movements: true } })
        expect(fundAfter.settledAt).not.toBeNull()
        expect(fundAfter.settledBalanceCents).toBe(fundBalance(fundBefore.movements))
        if (refund) expect(fundAfter.movements.find((m) => m.kind === "SETTLEMENT_REFUND")).toMatchObject({ amountCents: refund.amountCents, refundReference: refund.reference.toUpperCase(), refundDocumentId: refund.documentId })
        else expect(fundAfter.movements).toHaveLength(fundBefore.movements.length)
      }
      await ruleRefuses(database(), { table: "FinancedAsset", trigger: "FinancedAsset_total_loss_guard" }, /total-loss asset cannot be returned/, async (tx) => {
        await tx.financedAsset.update({ where: { id: fx.assets[index] }, data: { lessorStatus: "RETURNED_TO_STOCK" } })
      })
    }, 120_000)
  }
  it("keeps unpaid damages open, then genuine receipt closes without a return", async () => {
    const dealId = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[3], entityId: fx.evidenced, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS" }))
    await signLease(fx, database(), setSession, dealId)
    const loanId = await payoutAndBook(fx, database(), staff, dealId)
    const actor = { tenantId: fx.tenantId, userId: fx.adminA }
    const today = sastCalendarDate(new Date())
    expect(await database().$transaction((tx) => recordLeaseTotalLoss(tx as never, actor, { loanId, today, insuranceProceedsCents: 0, evidence: "Synthetic irreparable write-off" }))).toMatchObject({ kind: "recorded" })
    expect(await database().$transaction((tx) => invoiceEndOfTerm(tx as never, actor, { loanId, today }))).toMatchObject({ kind: "ok" })
    expect(await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId } })).toMatchObject({ status: "INVOICED" })
    await payAllOwed(database(), fx, loanId)
    expect(await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId } })).toMatchObject({ status: "COMPLETED", inspectedOn: null })
    expect(await database().financedAsset.findUniqueOrThrow({ where: { id: fx.assets[3] } })).toMatchObject({ lessorStatus: "TOTAL_LOSS" })
  }, 120_000)

})
