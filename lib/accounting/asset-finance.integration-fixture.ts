/**
 * Real-Postgres fixture for the asset-finance journal suite
 * (RUN_ACCOUNTING_IT): writes a SourceLoan, the shape the journal sources
 * read, as the rows the loader reads back (lib/accounting/store-asset-finance.ts),
 * with triggers off. Test setup only: the booking, lease, recovery and VAT
 * paths have their own suites, and the point here is that the loader, the
 * ledger, the independent SQL and the controls agree on whatever those leave
 * in the tables. Every value is synthetic. Not a test file.
 */
import type { Prisma, PrismaClient } from "@prisma/client"
import { sastCalendarDate } from "@/lib/date/sast"
import type { ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import type { SourceInvoice, SourceLoan } from "./source-types"

/** A `@db.Date` value for a SAST-midnight instant. */
export const dbDay = (d: Date): Date => new Date(`${sastCalendarDate(d)}T00:00:00Z`)

let invoiceCounter = 0
let creditCounter = 0

const invoiceRow = (t: ChargesTenant, inv: SourceInvoice, loanId: string | null): Prisma.TaxInvoiceUncheckedCreateInput => ({
  id: inv.id, tenantId: t.tenantId, number: ++invoiceCounter, invoiceNumber: `INV-${invoiceCounter}`, issueDate: dbDay(inv.issueDate), supplyDate: dbDay(inv.supplyDate), loanId,
  supplierName: "TEST Lender", supplierAddress: "1 Test Street", supplierVatNumber: "4000000001", recipientName: "TEST Debtor", recipientAddress: "2 Test Road",
  vatRate: 0.15, totalExclVatCents: inv.exclVatCents, vatCents: inv.vatCents, totalInclVatCents: inv.inclVatCents,
})

type Op = Prisma.PrismaPromise<unknown>

const creditNote = (db: PrismaClient, t: ChargesTenant, invoiceId: string, n: { id: string; issueDate: Date; exclVatCents: number; vatCents: number; inclVatCents: number }): Op =>
  db.creditNote.create({ data: {
    id: n.id, tenantId: t.tenantId, number: ++creditCounter, creditNoteNumber: `CN-${creditCounter}`, issueDate: dbDay(n.issueDate), invoiceId, reason: "Synthetic credit",
    exclVatCents: n.exclVatCents, vatCents: n.vatCents, inclVatCents: n.inclVatCents,
  } })

function recoveryOps(db: PrismaClient, t: ChargesTenant, loan: SourceLoan, assetId: string): Op[] {
  const af = loan.assetFinance!
  const ops: Op[] = []
  for (const rec of af.recoveries) {
    const settled = rec.proceedsDate !== null
    // The figures the proceeds step writes (Recovery_figures_all_or_none, Recovery_shortfall_surplus): net = sale - deducted costs;
    // the owed settlement is whatever leaves the worked surplus, or a little more than the net when there is a shortfall.
    const gross = rec.sale?.priceInclVatCents ?? 0
    const deducted = rec.costs.filter((c) => c.treatment === "DEDUCT_FROM_PROCEEDS").reduce((sum, c) => sum + c.grossCents, 0)
    const charged = rec.costs.filter((c) => c.treatment === "CHARGE_TO_ACCOUNT").reduce((sum, c) => sum + c.grossCents, 0)
    const net = gross - deducted
    const settlement = rec.surplusCents > 0 ? net - rec.surplusCents - charged : net + 1_000
    ops.push(db.recovery.create({ data: {
      id: rec.id, tenantId: t.tenantId, loanId: loan.id, assetId, route: "NON_NCA_VOLUNTARY",
      status: rec.withdrawnAt ? "WITHDRAWN" : settled ? "PROCEEDS_APPLIED" : rec.sale ? "SOLD" : "RECOVERED",
      recoveredOn: dbDay(rec.vatEvents[0]?.eventDate ?? loan.startDate), location: "TEST Yard", condition: "Synthetic: fair", createdById: t.userId,
      ...(settled ? {
        settlementDueCents: settlement, grossProceedsCents: gross, deductedCostsCents: deducted, chargedCostsCents: charged, netProceedsCents: net,
        shortfallCents: Math.max(0, settlement + charged - net), surplusCents: rec.surplusCents, chargesFrozenFrom: dbDay(rec.proceedsDate!), proceedsPaymentId: rec.proceedsPaymentId,
      } : {}),
      ...(rec.withdrawnAt ? { withdrawnReason: "Debtor paid the arrears", closedAt: rec.withdrawnAt } : {}),
    } }))
    for (const c of rec.costs) {
      ops.push(db.recoveryCost.create({ data: {
        id: c.id, tenantId: t.tenantId, recoveryId: rec.id, type: c.treatment === "CHARGE_TO_ACCOUNT" ? "LEGAL_CONTRACTUAL" : "TOWING",
        netCents: c.netCents, vatCents: c.vatCents, grossCents: c.grossCents, supplierInvoiceRef: `SUP-${c.id}`, incurredOn: dbDay(c.incurredOn),
        treatment: c.treatment, recordedById: t.userId, status: "APPROVED", approvedById: "approver-it", approvedAt: c.incurredOn,
      } }))
    }
    for (const e of rec.vatEvents) {
      ops.push(db.recoveryVatEvent.create({ data: {
        id: e.id, tenantId: t.tenantId, recoveryId: rec.id, kind: "REPOSSESSION_DEEMED_SUPPLY", eventDate: dbDay(e.eventDate), dealContractType: "INSTALMENT_SALE",
        debtorVatVendor: false, deemedSupplyValueCents: 575_000, inputTaxClaimCents: e.inputTaxClaimCents, outputTaxCents: 0, vatRateTenThousandths: 1500,
        basis: "Synthetic", recordedById: t.userId,
      } }))
    }
    if (rec.sale) {
      ops.push(db.taxInvoice.create({ data: invoiceRow(t, rec.sale.invoice, null) }))
      ops.push(db.remarketingSale.create({ data: {
        id: rec.sale.id, tenantId: t.tenantId, recoveryId: rec.id, status: "COMPLETED", channel: "AUCTION", buyerType: "PERSON", buyerName: "TEST Buyer",
        buyerIdentifier: "TEST-1", buyerAddress: "3 Buyer Street", priceInclVatCents: rec.sale.priceInclVatCents, valuationId: `val-${rec.id}`,
        highestValuationCents: rec.sale.priceInclVatCents, belowValuation: false, relatedPartyMatch: false, screeningResult: {}, createdById: t.userId,
        completedAt: rec.sale.invoice.issueDate, taxInvoiceId: rec.sale.invoice.id, proceedsPaymentId: rec.proceedsPaymentId,
      } }))
      for (const n of rec.sale.creditNotes ?? []) ops.push(creditNote(db, t, rec.sale.invoice.id, n))
    }
    if (rec.refund) {
      ops.push(db.recoveryRefund.create({ data: {
        id: rec.refund.id, tenantId: t.tenantId, recoveryId: rec.id, amountCents: rec.refund.amountCents, accountHolder: "TEST Debtor", bankName: "TEST Bank",
        branchCode: "000001", accountNumber: "0000000001", bankVerifiedById: t.userId, bankVerificationDocumentId: `doc-${rec.id}`, status: "RELEASED",
        createdById: t.userId, approvedById: "approver-it", releasedById: "releaser-it", releasedAt: rec.refund.releasedAt,
      } }))
    }
  }
  return ops
}

function leaseOps(db: PrismaClient, t: ChargesTenant, loan: SourceLoan): Op[] {
  const af = loan.assetFinance!
  const ops: Op[] = []
  af.rentals.forEach((r, i) => {
    ops.push(db.taxInvoice.create({ data: invoiceRow(t, r.invoice, loan.id) }))
    ops.push(db.leaseRental.create({ data: {
      id: r.id, tenantId: t.tenantId, loanId: loan.id, scheduleId: loan.schedule[i]?.id ?? `sched-${r.id}`, periodNo: i + 1, dueDate: dbDay(r.invoice.supplyDate),
      rentalExclVatCents: r.rentalExclVatCents, maintenanceExclVatCents: r.maintenanceExclVatCents, vatCents: r.vatCents, totalCents: r.totalCents,
      vatRate: 0.15, taxInvoiceId: r.invoice.id,
    } }))
  })
  for (const inv of af.sundryInvoices) {
    ops.push(db.taxInvoice.create({ data: invoiceRow(t, inv, loan.id) }))
    if (inv.assetSaleExclVatCents > 0) {
      ops.push(db.leaseEndOfTerm.create({ data: {
        tenantId: t.tenantId, loanId: loan.id, origin: "EXPIRY", outcome: "PURCHASE", status: "INVOICED", taxInvoiceId: inv.id, scheduleId: `sched-${inv.id}`, purchaseValuationId: `val-${inv.id}`, purchasePriceExclVatCents: inv.assetSaleExclVatCents,
      } }))
    }
  }
  if (af.fund) {
    ops.push(db.maintenanceFund.create({ data: { id: `fund-${loan.id}`, tenantId: t.tenantId, loanId: loan.id, riskModel: af.fund.riskModel, leaseEndDate: dbDay(loan.startDate) } }))
    // The shape CHECK: a contribution names its rental, a claim its claim, a billed deficit its invoice.
    let contributions = 0
    for (const m of af.fund.movements) {
      const link = m.kind === "CONTRIBUTION" ? { leaseRentalId: af.rentals[contributions++].id } : m.kind === "CLAIM" ? { claimId: `claim-${m.id}` } : m.kind === "SETTLEMENT_BILLED" ? { taxInvoiceId: af.sundryInvoices[0].id } : {}
      ops.push(db.maintenanceFundMovement.create({ data: { id: m.id, tenantId: t.tenantId, fundId: `fund-${loan.id}`, kind: m.kind, amountCents: m.amountCents, occurredOn: dbDay(m.occurredOn), ...link } }))
    }
  }
  return ops
}

/** Writes `loan` and everything the loader reads about it. */
export async function insertSourceLoan(db: PrismaClient, t: ChargesTenant, loan: SourceLoan): Promise<void> {
  const af = loan.assetFinance!
  const lease = af.contractType === "OPERATING_LEASE" || af.contractType === "FULL_MAINTENANCE_LEASE"
  const assetId = `asset-${loan.id}`
  const cost = lease ? af.asset : { exclVatCents: af.inceptionInvoice?.exclVatCents ?? 0, vatCents: af.inceptionInvoice?.vatCents ?? 0 }
  const totalRepayable = loan.schedule.reduce((sum, r) => sum + r.totalDue, 0)
  const ops: Op[] = [
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.businessEntity.create({ data: { id: `ent-${loan.id}`, tenantId: t.tenantId, type: "COMPANY", legalName: "TEST Accounting Borrower", registrationNumber: `TEST-${loan.id}` } }),
    db.loanApplication.create({ data: { id: `app-${loan.id}`, tenantId: t.tenantId, reference: `APP-${loan.reference}`, entityId: `ent-${loan.id}`, productId: t.productId, appliedAmount: loan.principal, appliedTermDays: 365, status: "DISBURSED", disbursedAt: loan.startDate, repaymentMethod: "EFT", approvedAt: loan.startDate, approvedById: t.userId, ncaRegime: "NON_NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD", ncaClassifiedAt: loan.startDate, ncaClassifiedById: t.userId } }),
    db.financedAsset.create({ data: { id: assetId, tenantId: t.tenantId, assetClass: "EXCAVATOR", make: "TEST", model: "EX-R", year: 2025, serialNumber: `SN-${loan.id}`, cashPriceExclVatCents: cost.exclVatCents, vatCents: cost.vatCents } }),
    db.loan.create({ data: {
      id: loan.id, tenantId: t.tenantId, reference: loan.reference, applicationId: `app-${loan.id}`, productId: t.productId, principal: loan.principal, totalInterest: 0,
      initiationFee: 0, totalRepayable, outstandingPrincipal: loan.principal, startDate: loan.startDate, maturityDate: new Date("2031-01-01T00:00:00Z"), interestRatePm: 0.01,
      interestModel: "REDUCING_BALANCE", status: loan.status as "ACTIVE", writeOffAt: loan.writeOffAt, closedAt: loan.closedAt, contractType: af.contractType, ncaRegime: "NON_NCA", assetId, entityId: `ent-${loan.id}`,
      ...(lease ? { cpaApplies: true, cpaRule: "CPA_JURISTIC_UNDER_THRESHOLD" } : {}),
    } }),
  ]
  if (af.payout) {
    ops.push(db.assetFinanceDeal.create({ data: {
      id: `deal-${loan.id}`, tenantId: t.tenantId, applicationId: `app-${loan.id}`, assetId, supplierId: `sup-${loan.id}`, entityId: `ent-${loan.id}`, loanId: loan.id, contractType: af.contractType, status: "BOOKED",
      financedFeesCents: af.financedFeesCents, weights: [], structurePreset: "MONTHLY", firstDueDate: dbDay(loan.startDate), rateBasis: "FIXED", createdById: t.userId,
      ...(lease ? {
        rentalTiming: "ADVANCE" as const, escalationRate: 0, earlyTerminationPenaltyRate: 0.05, cpaApplies: true, cpaRule: "CPA_JURISTIC_UNDER_THRESHOLD",
        ...(af.contractType === "FULL_MAINTENANCE_LEASE" ? {
          maintenanceMonthlyExclVatCents: 20_000, maintenanceEscalationRate: 0, maintenanceRiskModel: af.fund?.riskModel ?? "LENDER_RISK",
          usageAllowancePerYear: 1000, usageUnit: "HOURS" as const, excessRateCents: 100,
        } : {}),
      } : {}),
    } }))
    ops.push(db.payout.create({ data: {
      id: `payout-${loan.id}`, tenantId: t.tenantId, dealId: `deal-${loan.id}`, supplierBankAccountId: `bank-${loan.id}`, amountCents: af.payout.amountCents, status: "RELEASED",
      createdById: t.userId, approvedById: t.userId, approvedAt: af.payout.releasedAt, releasedById: t.userId, releasedAt: af.payout.releasedAt,
    } }))
  }
  if (af.inceptionInvoice) ops.push(db.taxInvoice.create({ data: invoiceRow(t, af.inceptionInvoice, loan.id) }))
  for (const r of loan.schedule) {
    ops.push(db.repaymentSchedule.create({ data: {
      id: r.id, tenantId: t.tenantId, loanId: loan.id, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.totalDue - r.interestDue, interestDue: r.interestDue,
      feesDue: 0, totalDue: r.totalDue, assetFinanceOpeningBalanceCents: r.openingBalanceCents ?? null,
    } }))
  }
  for (const p of loan.payments) {
    ops.push(db.payment.create({ data: { id: p.id, tenantId: t.tenantId, loanId: loan.id, amount: p.amount, paymentMethod: "EFT", receivedAt: p.receivedAt, allocationStatus: p.allocationStatus } }))
  }
  for (const c of loan.charges) {
    ops.push(db.loanCharge.create({ data: { tenantId: t.tenantId, loanId: loan.id, type: c.type as "RECOVERY_COST", day: dbDay(c.day), amount: c.amount, sourceId: c.sourceId } }))
  }
  const credits = af.creditNotes.map((n) => creditNote(db, t, n.invoiceId, n))
  await db.$transaction([...ops, ...(lease ? leaseOps(db, t, loan) : []), ...credits, ...recoveryOps(db, t, loan, assetId)])
}

/** Removes what insertSourceLoan wrote for these loans (triggers off), also left over by an earlier failed run. */
export async function removeSourceLoans(db: PrismaClient, loanIds: string[]): Promise<void> {
  const byLoan = { loanId: { in: loanIds } }
  const recoveries = (await db.recovery.findMany({ where: byLoan, select: { id: true } })).map((r) => r.id)
  const invoices = (await db.taxInvoice.findMany({ where: { OR: [byLoan, { remarketingSale: { recoveryId: { in: recoveries } } }] }, select: { id: true } })).map((i) => i.id)
  const byRecovery = { recoveryId: { in: recoveries } }
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.creditNote.deleteMany({ where: { invoiceId: { in: invoices } } }),
    db.recoveryRefund.deleteMany({ where: byRecovery }),
    db.remarketingSale.deleteMany({ where: byRecovery }),
    db.recoveryVatEvent.deleteMany({ where: byRecovery }),
    db.recoveryCost.deleteMany({ where: byRecovery }),
    db.recovery.deleteMany({ where: byLoan }),
    db.maintenanceFundMovement.deleteMany({ where: { fund: byLoan } }),
    db.maintenanceFund.deleteMany({ where: byLoan }),
    db.leaseEndOfTerm.deleteMany({ where: byLoan }),
    db.leaseRental.deleteMany({ where: byLoan }),
    db.loanCharge.deleteMany({ where: byLoan }),
    db.payment.deleteMany({ where: byLoan }),
    db.repaymentSchedule.deleteMany({ where: byLoan }),
    db.payout.deleteMany({ where: { deal: byLoan } }),
    db.assetFinanceDeal.deleteMany({ where: byLoan }),
    db.taxInvoiceLine.deleteMany({ where: { invoiceId: { in: invoices } } }),
    db.taxInvoice.deleteMany({ where: { id: { in: invoices } } }),
    db.loan.deleteMany({ where: { id: { in: loanIds } } }),
    db.loanApplication.deleteMany({ where: { id: { in: loanIds.map((id) => `app-${id}`) } } }),
    db.businessEntity.deleteMany({ where: { id: { in: loanIds.map((id) => `ent-${id}`) } } }),
    db.financedAsset.deleteMany({ where: { id: { in: loanIds.map((id) => `asset-${id}`) } } }),
  ])
}
