/**
 * Books a CONTRACTED operating or full-maintenance lease whose payout is
 * APPROVED (slice 3, C3), inside booking's transaction (./booking.ts locks
 * the deal, application and asset first and dispatches here). ONE
 * transaction creates the Loan, its RepaymentSchedule, a LeaseRental per
 * rental and the booking ContractRate, moves the application APPROVED →
 * DISBURSED, the deal CONTRACTED → BOOKED and the payout APPROVED →
 * RELEASED, and writes the audit row.
 *
 * As for an instalment sale, the booked lease is the signed agreement: the
 * rate on the planned start, the base rental and the finance charges priced
 * now must equal the signed figures exactly (terms_changed), and the start
 * may not have passed. The rentals' VAT is at the rate in force on the
 * commencement date, as the signed agreement printed it.
 *
 * NO INCEPTION TAX INVOICE: the supplier invoices the lessor for the asset;
 * the lessee is invoiced per rental (./lease-invoices.ts). What is written is
 * ./lease-ledger.ts (the ledger mapping).
 */
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { generateReference } from "@/lib/utils"
import { loadRateOn, NoVatRateError } from "@/lib/vat/vat-rate"
import type { BookingResult } from "./booking"
import { BookingRaceError, signedTerms } from "./booking-terms"
import { recipientAddress, type BookingDeal, type BookingRefusal } from "./booking-load"
import { identifierMatchesAsset } from "./asset-identifier"
import { dbDate } from "./dates"
import { resolveRate } from "./deal-structure"
import { termsFromDeal } from "./deal-terms"
import { isLeaseTerms, priceLeaseTerms } from "./lease-structure"
import { planLeaseBooking } from "./lease-ledger"
import { payoutAmountCents } from "./payout-checklist"
import type { SigningActor, SigningTx } from "./signing-prepare"

const refuse = (reason: string, error: string): BookingRefusal => ({ kind: "refused", reason, error })

export async function bookLease(tx: SigningTx, actor: SigningActor, deal: BookingDeal, today: string): Promise<BookingResult> {
  const { tenantId } = actor
  const { application, asset, entity, client, payout } = deal
  if (application.ncaRegime !== "NON_NCA") return refuse("application_not_ready", "A lease's application is NON_NCA")
  if (deal.cpaApplies === null || deal.cpaRule === null) return refuse("cpa_scope", "The lease has no CPA scope")
  const terms = termsFromDeal(deal)
  if (!isLeaseTerms(terms)) return refuse("lease_terms", "The lease deal is missing its lease terms")
  const advance = terms.lease.rentalTiming === "ADVANCE"

  if (payout.amountCents !== payoutAmountCents({ ...asset, depositCents: deal.depositCents, tradeInCents: deal.tradeInCents })) {
    return refuse("asset_changed", "The asset price changed since the payout was created")
  }
  // A rental in advance falls due on the commencement date, which may be today.
  if (advance ? terms.firstDueDate < today : terms.firstDueDate <= today) {
    return refuse("first_due_passed", `The first rental (${terms.firstDueDate}) must fall ${advance ? "on or " : ""}after the booking date ${today}`)
  }
  const attested = deal.checklist[0]?.attestedIdentifier ?? null
  if (attested === null || !identifierMatchesAsset(attested, asset)) {
    return refuse("asset_changed", "The serial/VIN attested from the supplier invoice is not the asset's")
  }
  const signed = signedTerms(deal)
  if (!signed) return refuse("not_prepared", "The deal's contract terms were never fixed; prepare its documents")
  const start = signed.startDate
  if (today > start) {
    return refuse("start_passed", `The signed start date ${start} has passed (booking date ${today}): cancel the deal and do it again with a new start date`)
  }
  const rate = await resolveRate(tx, tenantId, terms.rate, start)
  if ("error" in rate) return refuse("rate_unavailable", rate.error)
  if (!new Prisma.Decimal(rate.annualRate).equals(signed.resultingRate)) {
    return refuse("terms_changed", `The rate in force on the start date ${start} is ${rate.annualRate}, not the signed ${signed.resultingRate.toString()}`)
  }
  // Every rental is tax-invoiced: the lessor must be a configured VAT vendor.
  if (!(await tx.vatConfig.findUnique({ where: { tenantId }, select: { tenantId: true } }))) {
    return refuse("vat_not_configured", "Configure the lender's VAT vendor details first: every rental is tax-invoiced")
  }
  const vat = await loadRateOn(tx, start).catch((error: unknown) => {
    if (error instanceof NoVatRateError) return null
    throw error
  })
  if (!vat) return refuse("vat_unavailable", `No VAT rate is in force on ${start}`)
  const priced = priceLeaseTerms(asset, terms, rate, start, vat.rateTenThousandths)
  if (!priced.ok) return refuse("structure_unsolvable", priced.error)
  const approved = application.approvedAmount ?? application.appliedAmount
  if (priced.result.financedAmountCents !== approved) {
    return refuse("terms_changed", `The lease capital ${priced.result.financedAmountCents} is not the approved ${approved} cents`)
  }
  if (priced.result.baseInstalmentCents !== signed.baseInstalmentCents || priced.result.totalInterestCents !== signed.totalInterestCents) {
    return refuse("terms_changed", `The rentals priced now (base ${priced.result.baseInstalmentCents}, finance charges ${priced.result.totalInterestCents} cents) are not the signed ones (${signed.baseInstalmentCents}, ${signed.totalInterestCents})`)
  }
  const lessee = entity ?? client
  if (!lessee) return refuse("borrower_missing", "The lessee is missing")
  if (!recipientAddress(lessee)) return refuse("borrower_address_missing", "Record the lessee's address first: every rental's tax invoice needs it")
  const rateColumns = terms.rate.basis === "FIXED"
    ? { fixedRate: new Prisma.Decimal(rate.annualRate) }
    : terms.rate.margin !== null ? { margin: new Prisma.Decimal(terms.rate.margin) } : null
  if (!rateColumns) return refuse("rate_unavailable", "A reference-linked deal needs a margin")
  const plan = planLeaseBooking({ lease: priced.lease, startDate: start, vatRate: vat.rate, payoutCents: payout.amountCents })

  const annualRate = new Prisma.Decimal(rate.annualRate)
  const loan = await tx.loan.create({
    data: {
      tenantId, reference: generateReference("LN"), applicationId: application.id,
      clientId: client?.id ?? null, entityId: entity?.id ?? null, productId: application.productId,
      ncaRegime: "NON_NCA", contractType: deal.contractType, balloonAmount: null,
      assetFinanceWeights: deal.weights as Prisma.InputJsonValue, assetId: asset.id,
      principal: plan.principal, totalInterest: plan.totalInterest, initiationFee: 0, creditLifePremiums: 0,
      totalRepayable: plan.totalRepayable, outstandingPrincipal: plan.principal, status: "ACTIVE",
      startDate: plan.startDate, maturityDate: plan.maturityDate, nextPaymentDate: plan.nextPaymentDate,
      interestRatePm: annualRate.div(12).toNumber(), interestModel: "REDUCING_BALANCE", monthlyServiceFee: 0,
      agreementDocId: application.agreementDocumentId,
      nonNcaDefaultInterestMargin: signed.arrearsMarginRate, nonNcaCollectionFeeCents: signed.collectionFeeCents,
      cpaApplies: deal.cpaApplies, cpaRule: deal.cpaRule,
    },
    select: { id: true, reference: true },
  })
  const schedule = await tx.repaymentSchedule.createManyAndReturn({
    data: plan.records.map((record, i) => ({
      ...record, tenantId, loanId: loan.id, status: "PENDING" as const, assetFinanceOpeningBalanceCents: plan.openingBalances[i],
    })),
    select: { id: true, installmentNo: true },
  })
  const scheduleIds = new Map(schedule.map((row) => [row.installmentNo, row.id]))
  await tx.leaseRental.createMany({
    data: plan.rentals.map((rental) => {
      const scheduleId = scheduleIds.get(rental.periodNo)
      if (!scheduleId) throw new BookingRaceError(`Schedule row ${rental.periodNo}`)
      return { ...rental, tenantId, loanId: loan.id, scheduleId, vatRate: new Prisma.Decimal(rental.vatRate) }
    }),
  })
  const disbursedAt = new Date()
  const disbursed = await tx.loanApplication.updateMany({
    where: { id: application.id, tenantId, status: "APPROVED", ncaRegime: "NON_NCA" },
    data: { status: "DISBURSED", disbursedAt },
  })
  if (disbursed.count !== 1) throw new BookingRaceError("The application")
  const contractRate = await tx.contractRate.create({
    data: {
      tenantId, loanId: loan.id, effectiveDate: dbDate(start), basis: terms.rate.basis, ...rateColumns,
      resultingRate: annualRate, newInstalmentCents: plan.baseInstalmentCents, createdById: actor.userId,
    },
    select: { id: true },
  })
  const booked = await tx.assetFinanceDeal.updateMany({
    where: { id: deal.id, tenantId, status: "CONTRACTED", loanId: null },
    data: { status: "BOOKED", loanId: loan.id, baseInstalmentCents: plan.baseInstalmentCents },
  })
  if (booked.count !== 1) throw new BookingRaceError("The deal")
  const released = await tx.payout.updateMany({
    where: { id: payout.id, tenantId, status: "APPROVED" },
    data: { status: "RELEASED", releasedAt: disbursedAt, releasedById: actor.userId },
  })
  if (released.count !== 1) throw new BookingRaceError("The payout")

  await logAuditStrict({
    tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
    action: AuditAction.ASSET_DEAL_BOOKED, entity: "AssetFinanceDeal", entityId: deal.id,
    oldValue: { status: "CONTRACTED", applicationStatus: "APPROVED", payoutStatus: "APPROVED" },
    newValue: {
      status: "BOOKED", contractType: deal.contractType, loanId: loan.id, loanReference: loan.reference, applicationId: application.id,
      payoutId: payout.id, payoutAmountCents: payout.amountCents, startDate: start, bookingDate: today, firstDueDate: terms.firstDueDate,
      rentalTiming: terms.lease.rentalTiming, annualRate: rate.annualRate, reference: rate.reference, contractRateId: contractRate.id,
      baseRentalCents: plan.baseInstalmentCents, capitalCents: priced.result.financedAmountCents, residualCents: deal.balloonCents,
      financeChargesCents: priced.result.totalInterestCents, totalRentalsInclVatCents: plan.totalRepayable, rentals: plan.records.length,
      vatRate: vat.rate, cpaApplies: deal.cpaApplies, cpaRule: deal.cpaRule,
      arrearsMarginRate: signed.arrearsMarginRate?.toString() ?? null, collectionFeeCents: signed.collectionFeeCents,
      taxInvoiceId: null, ledger: "LEASE_RENTALS",
    },
  }, tx)
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  return { kind: "booked", loanId: loan.id, loanReference: loan.reference, taxInvoiceId: null, invoiceNumber: null }
}
