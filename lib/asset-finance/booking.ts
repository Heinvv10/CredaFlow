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
 * THE BOOKED LOAN IS THE SIGNED AGREEMENT. The loan starts on the deal's
 * plannedStartDate, fixed when the documents were prepared
 * (./signing-prepare.ts), not on the booking day. The structure is re-solved
 * from it with the deal's firstDueDate at the rate in force on it: FIXED, or
 * the APPROVED reference on the start date plus the margin (./deal-structure.ts
 * resolveRate; the ContractRate row records exactly that). Unless that rate,
 * the base instalment and the total interest equal the figures signed
 * (signedResultingRate, signedBaseInstalmentCents, signedTotalInterestCents)
 * exactly, booking is refused (terms_changed): a reference rate approved
 * after signing, or any change to the deal, would book a contract nobody
 * signed. The arrears terms are the deal's signed ones (signedArrears*),
 * never the product's now. The booking day (`today`, the payout date, also
 * the tax invoice's supply date) may not be after the planned start
 * (start_passed): the loan would start before it was paid out. The signed
 * terms cannot be re-prepared once signing has started, so a deal whose start
 * slipped is cancelled and done again with a new start date. The first
 * instalment must still fall after the booking day. What is written is
 * ./booking-plan.ts.
 *
 * The serial/VIN attested from the supplier invoice is checked against the
 * asset once more (guardAssetDealBooking checks it in the database too).
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
import { identifierMatchesAsset } from "./asset-identifier"
import { dbDate } from "./dates"
import { resolveRate, solveDealStructure } from "./deal-structure"
import { solveNcaDealStructure } from "./nca-structure"
import { pasqEvidenceIsIntact } from "@/lib/compliance/pasq"
import { termsFromDeal } from "./deal-terms"
import { payoutAmountCents } from "./payout-checklist"
import type { SigningActor } from "./signing-prepare"
import { BookingRaceError, signedTerms } from "./booking-terms"

export { BookingRaceError } from "./booking-terms"
import { isLeaseContract } from "./lease-input"
import { bookLease } from "./lease-booking"

export type BookingResult =
  | { kind: "not_found" }
  | BookingRefusal
  /** A lease books no inception tax invoice: taxInvoiceId and invoiceNumber are null. */
  | { kind: "booked"; loanId: string; loanReference: string; taxInvoiceId: string | null; invoiceNumber: string | null }

const refuse = (reason: string, error: string): BookingRefusal => ({ kind: "refused", reason, error })

export async function bookDeal(actor: SigningActor, dealId: string, today: string): Promise<BookingResult> {
  const { tenantId } = actor
  return prisma.$transaction(async (tx) => {
    const loaded = await loadBookingDeal(tx, tenantId, dealId)
    if (loaded.kind !== "loaded") return loaded
    const { deal } = loaded
    // An operating or full-maintenance lease books its rentals (./lease-booking.ts).
    if (isLeaseContract(deal.contractType)) return bookLease(tx, actor, deal, today)
    const { application, asset, entity, client, payout } = deal
    const ncaRegime = application.ncaRegime
    if (!ncaRegime) return refuse("application_not_ready", "The application has no NCA classification")
    const isNca = ncaRegime === "NCA"

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
    const solved = isNca ? solveNcaDealStructure(asset, terms, rate, start) : solveDealStructure(asset, terms, rate, start)
    if (!solved.ok) return refuse("structure_unsolvable", solved.error)
    const approved = application.approvedAmount ?? application.appliedAmount
    if (solved.result.financedAmountCents !== approved) {
      return refuse("terms_changed", `The financed amount ${solved.result.financedAmountCents} is not the approved ${approved} cents`)
    }
    if (solved.result.baseInstalmentCents !== signed.baseInstalmentCents || solved.result.totalInterestCents !== signed.totalInterestCents) {
      return refuse("terms_changed", `The schedule solved now (instalment ${solved.result.baseInstalmentCents}, interest ${solved.result.totalInterestCents} cents) is not the signed one (${signed.baseInstalmentCents}, ${signed.totalInterestCents})`)
    }
    const borrower = entity ?? client
    if (!borrower) return refuse("borrower_missing", "The borrower is missing")
    const address = recipientAddress(borrower)
    if (!address) return refuse("borrower_address_missing", "Record the borrower's address first: the tax invoice needs it")
    const rateColumns = terms.rate.basis === "FIXED"
      ? { fixedRate: new Prisma.Decimal(rate.annualRate) }
      : terms.rate.margin !== null ? { margin: new Prisma.Decimal(terms.rate.margin) } : null
    if (!rateColumns) return refuse("rate_unavailable", "A reference-linked deal needs a margin")
    const basePlan = planBooking({ result: solved.result, startDate: start, balloonCents: deal.balloonCents, payoutCents: payout.amountCents })
    const ncaEvidence = isNca && pasqEvidenceIsIntact(application.pasqEvidence) ? application.pasqEvidence : null
    if (isNca && !ncaEvidence) return refuse("pasq_evidence", "The acknowledged NCA quotation evidence is not intact")
    if (ncaEvidence && ncaEvidence.billing.schedule.length !== basePlan.records.length) return refuse("terms_changed", "The signed NCA schedule length no longer matches")
    const records = ncaEvidence ? basePlan.records.map((record, index) => {
      const agreed = ncaEvidence.billing.schedule[index]
      if (record.principalDue !== agreed.principalDueCents || record.interestDue !== agreed.interestDueCents || record.feesDue !== agreed.baseFeesDueCents) {
        throw new BookingRaceError("The signed NCA schedule")
      }
      return { ...record, feesDue: agreed.feesDueCents, creditLifePremiumDue: agreed.creditLifePremiumDueCents, totalDue: agreed.totalDueCents }
    }) : basePlan.records
    const plan = ncaEvidence ? {
      ...basePlan, records, principal: ncaEvidence.calculator.principalCents,
      totalInterest: ncaEvidence.calculator.totalInterestCents,
      totalRepayable: ncaEvidence.billing.totalRepayableCents,
    } : basePlan
    let creditLifeBundle: { clientId: string; productId: string; insurerId: string | null; commissionRate: Prisma.Decimal; premiumAmount: number } | null = null
    if (ncaEvidence?.creditLife.election === "ACCEPTED") {
      if (!application.creditLifeProductId || !application.creditLifeMonthlyPremiumCents || !client) {
        return refuse("credit_life_evidence", "Accepted credit life is missing its product or premium evidence")
      }
      const product = await tx.insuranceProduct.findFirst({ where: {
        id: application.creditLifeProductId, tenantId, type: "CREDIT_LIFE", active: true,
      }, select: { id: true, insurerId: true, commissionRate: true } })
      if (!product) return refuse("credit_life_product", "The elected credit-life product is no longer active")
      creditLifeBundle = {
        clientId: client.id, productId: product.id, insurerId: product.insurerId,
        commissionRate: product.commissionRate, premiumAmount: application.creditLifeMonthlyPremiumCents / 100,
      }
    }

    const annualRate = new Prisma.Decimal(rate.annualRate)
    const loan = await tx.loan.create({
      data: {
        tenantId,
        reference: generateReference("LN"),
        applicationId: application.id,
        clientId: client?.id ?? null,
        entityId: entity?.id ?? null,
        productId: application.productId,
        ncaRegime,
        contractType: deal.contractType,
        balloonAmount: deal.balloonCents > 0 ? deal.balloonCents : null,
        assetFinanceWeights: deal.weights as Prisma.InputJsonValue,
        assetId: asset.id,
        principal: plan.principal,
        totalInterest: plan.totalInterest,
        initiationFee: ncaEvidence?.calculator.initiationFeeCents ?? 0,
        creditLifePremiums: ncaEvidence?.creditLife.totalPremiumCents ?? 0,
        totalRepayable: plan.totalRepayable,
        outstandingPrincipal: plan.principal,
        status: "ACTIVE",
        startDate: plan.startDate,
        maturityDate: plan.maturityDate,
        nextPaymentDate: plan.nextPaymentDate,
        interestRatePm: annualRate.div(12).toNumber(),
        interestModel: "REDUCING_BALANCE",
        monthlyServiceFee: ncaEvidence ? Math.round(ncaEvidence.calculator.serviceFeesCents / ncaEvidence.calculator.schedule.length) : 0,
        agreementDocId: application.agreementDocumentId,
        nonNcaDefaultInterestMargin: isNca ? null : signed.arrearsMarginRate,
        nonNcaCollectionFeeCents: isNca ? null : signed.collectionFeeCents,
      },
      select: { id: true, reference: true },
    })
    await tx.repaymentSchedule.createMany({
      data: plan.records.map((record, i) => ({
        ...record,
        tenantId,
        loanId: loan.id,
        status: "PENDING" as const,
        assetFinanceOpeningBalanceCents: solved.result.rows[i].openingBalanceCents,
      })),
    })
    if (creditLifeBundle) {
      const commissionAmount = Number((creditLifeBundle.premiumAmount * Number(creditLifeBundle.commissionRate)).toFixed(2))
      await tx.insurancePolicy.create({ data: {
        tenantId, policyNumber: generateReference("CL"), clientId: creditLifeBundle.clientId, type: "CREDIT_LIFE", status: "ACTIVE",
        premiumAmount: creditLifeBundle.premiumAmount, sumAssured: plan.principal / 100, linkedLoanId: loan.id,
        startDate: plan.startDate, renewalDate: plan.maturityDate, productId: creditLifeBundle.productId, insurerId: creditLifeBundle.insurerId,
        commissionRate: creditLifeBundle.commissionRate, commissionAmount, policySource: "BUNDLED_CREDIT_AGREEMENT",
      } })
    }
    const disbursedAt = new Date()
    const disbursed = await tx.loanApplication.updateMany({
      where: { id: application.id, tenantId, status: "APPROVED", ncaRegime },
      data: { status: "DISBURSED", disbursedAt },
    })
    if (disbursed.count !== 1) throw new BookingRaceError("The application")
    const contractRate = await tx.contractRate.create({
      data: {
        tenantId, loanId: loan.id, effectiveDate: dbDate(start), basis: terms.rate.basis,
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
      recipient: {
        name: entity?.legalName ?? `${client?.firstName ?? ""} ${client?.lastName ?? ""}`.trim(),
        address, vatNumber: entity?.vatNumber ?? null,
      },
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
        payoutId: payout.id, payoutAmountCents: payout.amountCents, startDate: start, bookingDate: today, firstDueDate: terms.firstDueDate,
        annualRate: rate.annualRate, reference: rate.reference, contractRateId: contractRate.id,
        baseInstalmentCents: plan.baseInstalmentCents, financedAmountCents: solved.result.financedAmountCents,
        principal: plan.principal, totalInterest: plan.totalInterest, totalRepayable: plan.totalRepayable,
        balloonCents: deal.balloonCents, instalments: plan.records.length,
        arrearsMarginRate: signed.arrearsMarginRate?.toString() ?? null, collectionFeeCents: signed.collectionFeeCents,
        taxInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, interestModel: "REDUCING_BALANCE",
      },
    }, tx)
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return { kind: "booked", loanId: loan.id, loanReference: loan.reference, taxInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber }
  }, { timeout: 20_000 })
}
