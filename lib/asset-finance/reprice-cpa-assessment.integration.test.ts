/** Joint B/D real-booking regression: immutable rate amendments feed cancellation guards. */
import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { sastCalendarDate } from "@/lib/date/sast"
import { runWithTenant } from "@/lib/tenant-scope"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { cleanupDealFixture } from "./deal.integration-fixture"
import { shiftLease } from "./lease-servicing.integration-fixture"
import { dbDate, isoOfDbDate } from "./dates"
import { repriceLoanForReference } from "./reprice-loan"
import { amendedLeaseRentals } from "./lease-rate-tax-adjustment"
import { presentValueOfRentals } from "./lease-termination"
import { createRecoveryTx } from "./recovery-create"
import { recordRecoveryValuation, listForSale } from "./recovery-store"
import { readJson, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
import { applySaleProceeds } from "./recovery-proceeds"
import { prepareLeaseRecoveryDamages } from "./lease-recovery-damages"
import { cleanupRecoveryRows } from "./recovery.integration-fixture"
import { CPA_CANCELLATION_FACTORS } from "./cpa-cancellation-assessment"
import { quoteEarlyTermination, acceptEarlyTermination } from "./lease-termination-store"
import { recordLeaseTotalLoss } from "./lease-total-loss"
import type { SigningTx } from "./signing-prepare"
import type { SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fixtures: LeaseFixture[] = []
suite.sequential("amended CPA rental claim and database assessment agree", () => {
  afterAll(async () => {
    for (const fx of fixtures) {
      await cleanupRecoveryRows(db, fx.tenantId).catch(() => undefined)
      await cleanupLeaseRows(db, fx.tenantId).catch(() => undefined)
      await cleanupDealFixture(db, { tenantId: fx.tenantId }).catch(() => undefined)
    }
    await db.$disconnect()
  }, 60000)
  it.each(["lessor", "consumer", "loss"] as const)("%s uses actual amended future consideration without rewriting history", async (path) => {
    process.env.TRUSTED_PROXY = "1"
    const fx = await createLeaseFixture(db, randomUUID().replaceAll("-", "").slice(0, 16)); fixtures.push(fx)
    const setSession = (user: SessionUser | null) => { session.current = user && { user } }
    const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@synthetic.invalid`, role, tenantId: fx.tenantId })
    const deal = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[0], clientId: fx.lessee, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", preset: { kind: "MONTHLY", periods: 12 }, escalationRate: "0" }))
    await signLease(fx, db, setSession, deal)
    const loanId = await payoutAndBook(fx, db, staff, deal)
    // Eleven real paid supplies, one uninvoiced future rental; a late reference
    // correction retains the original rows and records its period delta.
    await shiftLease(db, loanId, path === "consumer" ? "12 months - 45 days" : "12 months - 7 days")
    const rows = await db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
    await applyManualReceipt(db as unknown as PaymentDb, { tenantId: fx.tenantId, loanId, amount: rows.slice(0, -1).reduce((sum, row) => sum + row.totalDue, 0), capturedById: fx.adminA })
    if (path === "consumer") await applyManualReceipt(db as unknown as PaymentDb, { tenantId: fx.tenantId, loanId, amount: rows.at(-1)!.totalDue, capturedById: fx.adminA })
    const today = sastCalendarDate(new Date()), effectiveDate = new Date(dbDate(today).getTime() - 86400000).toISOString().slice(0, 10)
    const initial = await db.contractRate.findFirstOrThrow({ where: { loanId }, orderBy: { effectiveDate: "asc" } })
    const rate = new Prisma.Decimal(initial.resultingRate).add(path === "consumer" ? 0.3 : 0.02)
    const ref = await db.referenceRate.create({ data: { tenantId: fx.tenantId, basis: "PRIME", effectiveDate: dbDate(effectiveDate), rate: rate.sub(initial.margin!), requestedById: fx.adminA } })
    await db.referenceRate.update({ where: { id: ref.id }, data: { status: "APPROVED", decidedById: fx.adminB, decidedAt: new Date() } })
    expect((await db.$transaction(tx => repriceLoanForReference(tx as never, { tenantId: fx.tenantId, loanId, basis: "PRIME", effectiveDate, runDate: today, actorUserId: fx.adminA }))).kind).toBe("repriced")
    const originals = await db.leaseRental.findMany({ where: { loanId }, orderBy: { periodNo: "asc" } })
    const sources = await db.assetFinanceRateCorrection.findMany({ where: { loanId }, orderBy: { id: "asc" } })
    const amended = await amendedLeaseRentals(db as never, fx.tenantId, loanId, originals)
    expect(amended.at(-1)!.rentalExclVatCents).not.toBe(originals.at(-1)!.rentalExclVatCents)
    const supplied = await db.taxInvoice.findMany({ where: { loanId }, orderBy: { id: "asc" } })
    const cash = await db.payment.findMany({ where: { loanId }, orderBy: { id: "asc" } })
    const actor = { tenantId: fx.tenantId, userId: fx.adminA }
    const findings = Object.fromEntries(CPA_CANCELLATION_FACTORS.map(([key]) => [key, "Synthetic case-specific finding supported by retained evidence"]))
    if (path === "lessor") {
      const recovery = await db.$transaction(tx => createRecoveryTx(tx as never, actor, { loanId, route: "NON_NCA_VOLUNTARY", recoveredOn: today, location: "Synthetic yard", condition: "Synthetic returned plant" }))
      if (recovery.kind !== "done") throw new Error(JSON.stringify(recovery))
      const tenant = <T>(run: () => Promise<T>) => runWithTenant(fx.tenantId, run)
      expect(await tenant(() => recordRecoveryValuation({ ...actor, userId: fx.officer }, recovery.id, { source: "ASSESSOR", valuedOn: today, valuerName: "Synthetic valuer", amountCents: 20000 }))).toMatchObject({ kind: "done" })
      expect(await tenant(() => listForSale(actor, recovery.id))).toMatchObject({ kind: "done" })
      const valued = await db.recovery.findUniqueOrThrow({ where: { id: recovery.id } })
      staff(fx.adminA, "LOAN_ADMIN")
      const proposed = await readJson(await saleRoutes(fx.host).propose(recovery.id, saleBody(valued.valuationId!, 20000)))
      expect(proposed.status, JSON.stringify(proposed)).toBe(201)
      const saleId = proposed.body.id as string
      if (proposed.body.approvalRequired) { staff(fx.adminB, "LOAN_ADMIN"); expect((await saleRoutes(fx.host).approveSale(recovery.id, saleId)).status).toBe(200) }
      staff(fx.adminA, "LOAN_ADMIN")
      expect((await saleRoutes(fx.host).completeSale(recovery.id, saleId)).status).toBe(200)
      const assessment = { assessedChargeCents: 0, factors: findings, rationale: "Synthetic reduced loss", fairnessReason: "Synthetic proportionate claim" }
      // A forged 1c PV basis must fail the independent financial guard before
      // acceptance, rather than merely hitting accepted-quote immutability.
      await expect(db.$transaction(async tx => {
        const patched = new Proxy(tx, { get(target, key) {
          if (key !== "leaseTerminationQuote") return Reflect.get(target, key)
          return { ...tx.leaseTerminationQuote, create: (args: Prisma.LeaseTerminationQuoteCreateArgs) => {
            const a = args.data.reasonableAssessment as Prisma.JsonObject
            return tx.leaseTerminationQuote.create({ ...args, data: { ...args.data, reasonableAssessment: { ...a, pvExclVatCents: Number(a.pvExclVatCents) + 1 } } })
          } }
        } })
        return prepareLeaseRecoveryDamages(patched as unknown as SigningTx, { ...actor, loanId, recoveryId: recovery.id, recoveredOn: today, today, netProceedsCents: 20000, chargedCostsCents: 0, assessment })
      })).rejects.toThrow(/cpa_lessor_assessment/)
      const applied = await tenant(() => applySaleProceeds(actor, recovery.id, assessment))
      expect(applied, JSON.stringify(applied)).toMatchObject({ kind: "done" })
    } else if (path === "consumer") {
      const quoted = await db.$transaction(tx => quoteEarlyTermination(tx as never, actor, { loanId, today }))
      if (quoted.kind !== "quoted") throw new Error(JSON.stringify(quoted))
      const input = { quoteId: quoted.quoteId, today, assessment: { goodsValueCents: 0, costs: [], reasonableAssessment: { assessedChargeCents: 0, factors: findings, rationale: "Synthetic waiver", cancellationRightReason: "Synthetic waiver preserves cancellation" } } }
      await expect(db.$transaction(async tx => {
        const patched = new Proxy(tx, { get(target, key) {
          if (key !== "leaseTerminationQuote") return Reflect.get(target, key)
          return { ...tx.leaseTerminationQuote, update: (args: Prisma.LeaseTerminationQuoteUpdateArgs) => {
            const a = args.data.reasonableAssessment as Prisma.JsonObject | undefined
            return tx.leaseTerminationQuote.update(a ? { ...args, data: { ...args.data, reasonableAssessment: { ...a, ceilingCents: Number(a.ceilingCents) + 1 } } } : args)
          } }
        } })
        return acceptEarlyTermination(patched as unknown as SigningTx, actor, input)
      })).rejects.toThrow(/cpa_reasonable_assessment/)
      expect(await db.$transaction(tx => acceptEarlyTermination(tx as never, actor, input))).toMatchObject({ kind: "accepted" })
    } else {
      expect(await db.$transaction(tx => recordLeaseTotalLoss(tx as never, actor, { loanId, today, insuranceProceedsCents: 0, evidence: "Synthetic insured write-off" }))).toMatchObject({ kind: "recorded" })
    }
    const quote = await db.leaseTerminationQuote.findFirstOrThrow({ where: { loanId, status: "ACCEPTED" } })
    const oracle = presentValueOfRentals(amended.filter(r => r.dueDate > quote.terminationDate).map(r => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })), isoOfDbDate(quote.terminationDate), rate.toNumber())
    const remaining = amended.filter(r => r.dueDate > quote.terminationDate).reduce((sum, row) => sum + row.rentalExclVatCents, 0)
    if (path === "lessor") {
      expect((quote.reasonableAssessment as Prisma.JsonObject).pvExclVatCents).toBe(oracle)
      expect((quote.reasonableAssessment as Prisma.JsonObject).undiscountedRentalsCents).toBe(remaining)
    } else {
      expect(quote.pvCents).toBe(oracle)
      if (path === "consumer") expect((quote.reasonableAssessment as Prisma.JsonObject).ceilingCents).toBe(Math.max(0, Math.min(oracle, remaining - 1)))
    }
    expect(await db.assetFinanceRateCorrection.findMany({ where: { id: { in: sources.map(row => row.id) } }, orderBy: { id: "asc" } })).toEqual(sources)
    for (const original of cash) expect(await db.payment.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ amount: original.amount, receivedAt: original.receivedAt, paymentMethod: original.paymentMethod, capturedBy: original.capturedBy, reference: original.reference })
    for (const invoice of supplied) expect(await db.taxInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).toEqual(invoice)
    const retained = await db.leaseRental.findMany({ where: { loanId }, orderBy: { periodNo: "asc" } })
    expect(retained.map(row => row.rentalExclVatCents)).toEqual(originals.map(row => row.rentalExclVatCents))
  }, 120000)
})
