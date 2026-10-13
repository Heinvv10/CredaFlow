/**
 * Books a CONTRACTED asset deal whose payout is APPROVED (goal §4.10): ONE
 * transaction creates the Loan, its RepaymentSchedule, the booking
 * ContractRate and the inception tax invoice, moves the application APPROVED
 * → DISBURSED, the deal CONTRACTED → BOOKED and the payout APPROVED →
 * RELEASED, and writes the audit row. Any refusal or failure rolls all of it
 * back.
 *
 * RACE SAFETY (the disburse route's patterns, not its consumer gates): the
 * deal, application and asset rows are locked FOR UPDATE first, in that
 * order (the asset PATCH route locks the asset, so a concurrent price edit
 * either lands before the re-solve or waits for the loan). Every status move
 * is an updateMany pinned to the expected status; a count other than 1
 * throws BookingRaceError (409), which rolls back. The deferred constraint
 * triggers (the loan/disbursement commit rule, the invoice totals) are forced
 * with SET CONSTRAINTS ALL IMMEDIATE before the callback returns: at COMMIT
 * Prisma would report their rollback as success.
 *
 * ORDER. issueInstalmentSaleInvoice itself runs SET CONSTRAINTS ALL
 * IMMEDIATE, which fires the deferred Loan_credit_life_commit_invariant: the
 * schedule rows and the application's DISBURSED move must already exist by
 * then. The deal is BOOKED before the payout is RELEASED (guardPayout
 * releases only for a BOOKED deal; guardAssetDealBooking books only with the
 * payout APPROVED).
 *
 * START DATE = the booking day in SAST (the payout date). The structure is
 * re-solved from it with the deal's firstDueDate (refused when that is not
 * after the start) at the rate in force on it: FIXED, or the approved
 * reference on the start date plus the margin (./deal-structure.ts
 * resolveRate; the ContractRate row records exactly that). What is written is
 * ./booking-plan.ts.
 *
 * SLICE-1 LIMITATION: a reference-linked deal with a VAT-deferral period is
 * refused. Repricing cannot see a pending VAT lump (./reprice-loan.ts
 * PARTIAL) and would scale it with the new instalment.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { generateReference } from "@/lib/utils"
import { issueInstalmentSaleInvoice } from "@/lib/vat/tax-invoice"
import { planBooking } from "./booking-plan"
import { loadBookingDeal, recipientAddress, type BookingRefusal } from "./booking-load"
import { dbDate } from "./dates"
import { resolveRate, solveDealStructure } from "./deal-structure"
import { termsFromDeal } from "./deal-terms"
import { payoutAmountCents } from "./payout-checklist"
import type { SigningActor } from "./signing-prepare"

export class BookingRaceError extends Error {
  constructor(what: string) {
    super(`${what} changed while the deal was being booked; nothing was booked`)
    this.name = "BookingRaceError"
  }
}

export type BookingResult =
  | { kind: "not_found" }
  | BookingRefusal
  | { kind: "booked"; loanId: string; loanReference: string; taxInvoiceId: string; invoiceNumber: string }

const refuse = (reason: string, error: string): BookingRefusal => ({ kind: "refused", reason, error })

export async function bookDeal(actor: SigningActor, dealId: string, today: string): Promise<BookingResult> {
  const { tenantId } = actor
  return prisma.$transaction(async (tx) => {
    const loaded = await loadBookingDeal(tx, tenantId, dealId)
    if (loaded.kind !== "loaded") return loaded
    const { deal } = loaded
    const { application, asset, entity, payout } = deal

    const terms = termsFromDeal(deal)
    if (terms.vatDeferralPeriodIndex !== null && terms.rate.basis !== "FIXED") {
      return refuse("vat_deferral_reference_rate", "Slice 1 cannot book a reference-linked deal with a VAT-deferral period: repricing cannot carry the VAT lump")
    }
    const expectedPayout = payoutAmountCents({ ...asset, depositCents: deal.depositCents, tradeInCents: deal.tradeInCents })
    if (payout.amountCents !== expectedPayout) {
      return refuse("asset_changed", "The asset price, deposit or trade-in changed since the payout was created")
    }
    if (terms.firstDueDate <= today) {
      return refuse("first_due_passed", `The first instalment (${terms.firstDueDate}) must fall after the booking date ${today}`)
    }
    const rate = await resolveRate(tx, tenantId, terms.rate, today)
    if ("error" in rate) return refuse("rate_unavailable", rate.error)
    const solved = solveDealStructure(asset, terms, rate, today)
    if (!solved.ok) return refuse("structure_unsolvable", solved.error)
    const approved = application.approvedAmount ?? application.appliedAmount
    if (solved.result.financedAmountCents !== approved) {
      return refuse("terms_changed", `The financed amount ${solved.result.financedAmountCents} is not the approved ${approved} cents`)
    }
    const address = recipientAddress(entity)
    if (!address) return refuse("entity_address_missing", "Record the entity's address first: the tax invoice needs it")
    const rateColumns = terms.rate.basis === "FIXED"
      ? { fixedRate: new Prisma.Decimal(rate.annualRate) }
      : terms.rate.margin !== null ? { margin: new Prisma.Decimal(terms.rate.margin) } : null
    if (!rateColumns) return refuse("rate_unavailable", "A reference-linked deal needs a margin")
    const plan = planBooking({ result: solved.result, startDate: today, balloonCents: deal.balloonCents, payoutCents: payout.amountCents })

    const annualRate = new Prisma.Decimal(rate.annualRate)
    const loan = await tx.loan.create({
      data: {
        tenantId,
        reference: generateReference("LN"),
        applicationId: application.id,
        entityId: entity.id,
        productId: application.productId,
        ncaRegime: "NON_NCA",
        contractType: deal.contractType,
        balloonAmount: deal.balloonCents > 0 ? deal.balloonCents : null,
        assetId: asset.id,
        principal: plan.principal,
        totalInterest: plan.totalInterest,
        initiationFee: 0,
        totalRepayable: plan.totalRepayable,
        outstandingPrincipal: plan.principal,
        status: "ACTIVE",
        startDate: plan.startDate,
        maturityDate: plan.maturityDate,
        nextPaymentDate: plan.nextPaymentDate,
        interestRatePm: annualRate.div(12).toNumber(),
        interestModel: "REDUCING_BALANCE",
        monthlyServiceFee: 0,
        nonNcaDefaultInterestMargin: application.product.nonNcaDefaultInterestMargin,
        nonNcaCollectionFeeCents: application.product.nonNcaCollectionFeeCents,
      },
      select: { id: true, reference: true },
    })
    await tx.repaymentSchedule.createMany({
      data: plan.records.map((record) => ({ ...record, tenantId, loanId: loan.id, status: "PENDING" as const })),
    })
    const disbursedAt = new Date()
    const disbursed = await tx.loanApplication.updateMany({
      where: { id: application.id, tenantId, status: "APPROVED", ncaRegime: "NON_NCA" },
      data: { status: "DISBURSED", disbursedAt },
    })
    if (disbursed.count !== 1) throw new BookingRaceError("The application")
    const contractRate = await tx.contractRate.create({
      data: {
        tenantId, loanId: loan.id, effectiveDate: dbDate(today), basis: terms.rate.basis,
        ...rateColumns,
        resultingRate: annualRate,
        newInstalmentCents: plan.baseInstalmentCents,
        createdById: actor.userId,
      },
      select: { id: true },
    })
    const invoice = await issueInstalmentSaleInvoice(tx, {
      tenantId,
      loanId: loan.id,
      bookingDate: today,
      recipient: { name: entity.legalName, address, vatNumber: entity.vatNumber },
      asset,
      cashPriceCents: asset.cashPriceExclVatCents + asset.vatCents,
      createdById: actor.userId,
    })
    const booked = await tx.assetFinanceDeal.updateMany({
      where: { id: dealId, tenantId, status: "CONTRACTED", loanId: null },
      data: { status: "BOOKED", loanId: loan.id, baseInstalmentCents: plan.baseInstalmentCents },
    })
    if (booked.count !== 1) throw new BookingRaceError("The deal")
    const released = await tx.payout.updateMany({
      where: { id: payout.id, tenantId, status: "APPROVED" },
      data: { status: "RELEASED", releasedAt: disbursedAt, releasedById: actor.userId },
    })
    if (released.count !== 1) throw new BookingRaceError("The payout")

    await logAuditStrict({
      tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_DEAL_BOOKED,
      entity: "AssetFinanceDeal",
      entityId: dealId,
      oldValue: { status: "CONTRACTED", applicationStatus: "APPROVED", payoutStatus: "APPROVED" },
      newValue: {
        status: "BOOKED", loanId: loan.id, loanReference: loan.reference, applicationId: application.id,
        payoutId: payout.id, payoutAmountCents: payout.amountCents, startDate: today, firstDueDate: terms.firstDueDate,
        annualRate: rate.annualRate, reference: rate.reference, contractRateId: contractRate.id,
        baseInstalmentCents: plan.baseInstalmentCents, financedAmountCents: solved.result.financedAmountCents,
        principal: plan.principal, totalInterest: plan.totalInterest, totalRepayable: plan.totalRepayable,
        balloonCents: deal.balloonCents, instalments: plan.records.length,
        taxInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, interestModel: "REDUCING_BALANCE",
      },
    }, tx)
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return { kind: "booked", loanId: loan.id, loanReference: loan.reference, taxInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber }
  }, { timeout: 20_000 })
}
