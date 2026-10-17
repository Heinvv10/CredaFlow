/**
 * Commercial termination is priced and dated on acceptance. A CPA notice
 * itself fixes the effective date (20 SA business days), credits/cancels the
 * rentals after it and opens the return. Staff later assess the CPA charge
 * from goods value and documented actual costs; accepting a quote is never
 * a condition of cancellation. Unused invoiced supplies are credited, and
 * prepaid cash is retained in the ordinary reconciliation/refund ledger.
 * All writes share the caller's transaction and strict audit trail.
 */
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { describeAsset, issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { loadRateOn } from "@/lib/vat/vat-rate"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { recipientAddress } from "./booking-load"
import { dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
import { appendLeaseCharge, cancelFutureRentals } from "./lease-charges"
import { cpaCancellationDate, cpaCancellationCharge, earlyTerminationAmount, type CancellationCost } from "./lease-termination"
import type { SigningTx } from "./signing-prepare"
import { replayLeaseCancellationCredit } from "./lease-credit-replay"
import { assessReasonableCancellation } from "./cpa-cancellation-assessment"
import { formatMoney } from "./format"
import { clientLeaseRefusal } from "./lease-portal-route"

export type TerminationActor = { tenantId: string; userId: string; clientId?: undefined } | { tenantId: string; clientId: string; userId?: undefined }
export type TerminationResult =
  | { kind: "quoted"; quoteId: string; totalCents: number; terminationDate: string; validUntil: string }
  | { kind: "accepted"; quoteId: string; taxInvoiceId: string | null }
  | { kind: "not_found" }
  | { kind: "refused"; reason: string; error: string }

const refused = (reason: string, error: string): TerminationResult => ({ kind: "refused", reason, error })

export const REG5_FACTORS = "CPA Regulation 5(2): the amount of the agreement, the length of notice given, the potential for the lessor to "
  + "find an alternative lessee or use for the asset, the time remaining, the lessor's reasonable loss and the nature of the goods"

function basisText(cpa: boolean, penaltyRate: string, terminationDate: string): string {
  if (cpa) return `Cancellation takes effect on ${terminationDate}, 20 South African business days after notice, without accepting a quote. The charge is the present value of remaining rentals at the contract rate, less the net realisable or re-let value of the returned goods, plus actual documented recovery, refurbishment and re-letting costs, floored at zero and capped below undiscounted remaining rentals. No percentage penalty. Arrears remain due. ${REG5_FACTORS}. This formula sets a financial ceiling only. Staff must record all applicable Regulation 5(2) factors, justify a reasonable charge at or below that ceiling and explain why it does not negate cancellation under Regulation 5(3). A reduction or full waiver is permitted. Until the goods valuation, costs and reasoned assessment are recorded the cancellation charge is not yet assessed.`
  const formula = `Present value of the rentals (ex VAT and maintenance) falling due after ${terminationDate}, discounted at the contract rate, `
    + `plus a penalty of ${(Number(penaltyRate) * 100).toFixed(2)}% of that present value, plus the arrears. The asset is returned; no credit is given for its resale value.`
  return formula
}

export async function quoteEarlyTermination(tx: SigningTx, actor: TerminationActor, input: { loanId: string; today: string }): Promise<TerminationResult> {
  const { tenantId } = actor
  const denied = await clientLeaseRefusal(actor, input.loanId)
  if (denied) return denied
  await lockLoanForUpdate(tx, input.loanId)
  const loan = await tx.loan.findFirst({
    where: { id: input.loanId, tenantId, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } },
    select: {
      id: true, status: true, cpaApplies: true, interestRatePm: true, totalRepayable: true, totalPaid: true, outstandingPrincipal: true, arrearsAmount: true, tenantId: true, principal: true, totalInterest: true, interestModel: true, startDate: true, maturityDate: true,
      contractualTotalInterest: true, contractualTotalRepayable: true,
      repaymentSchedule: true, leaseEndOfTerm: { select: { id: true } }, assetFinanceDeal: { select: { earlyTerminationPenaltyRate: true } },
      leaseRentals: { where: { cancelledAt: null }, select: { dueDate: true, rentalExclVatCents: true } },
      contractRates: { orderBy: { effectiveDate: "desc" }, take: 1, select: { resultingRate: true } },
    },
  })
  if (!loan) return { kind: "not_found" }
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED" && loan.status !== "COMPLETED") return refused("lease_closed", `The lease is ${loan.status}`)
  if (loan.leaseEndOfTerm && !loan.cpaApplies) return refused("end_of_term", "The lease's end of term is already under way")
  const penalty = loan.assetFinanceDeal?.earlyTerminationPenaltyRate
  if (!penalty) return refused("penalty", "The lease has no early-termination penalty rate")
  const cpa = loan.cpaApplies === true
  if (cpa) {
    const existing = await tx.leaseTerminationQuote.findFirst({ where: { tenantId, loanId: loan.id, cpaCancellation: true }, select: { id: true, totalCents: true, terminationDate: true, validUntil: true } })
    if (existing) return { kind: "quoted", quoteId: existing.id, totalCents: existing.totalCents, terminationDate: isoOfDbDate(existing.terminationDate), validUntil: isoOfDbDate(existing.validUntil) }
    if (loan.leaseEndOfTerm) return refused("end_of_term", "The lease already has an end-of-term choice; a continued lease ends by extension notice")
  }
  const terminationDate = cpa ? cpaCancellationDate(input.today) : input.today
  const config = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { leaseTerminationQuoteValidDays: true } })
  const validUntil = fromDayNumber(toDayNumber(input.today) + (config?.leaseTerminationQuoteValidDays ?? 10))
  const figures = await loanSettlementFigures(tx, loan, new Date())
  const vat = await loadRateOn(tx, input.today)
  let amount = earlyTerminationAmount({
    rentals: loan.leaseRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })),
    terminationDate, annualRate: Number(loan.contractRates[0]?.resultingRate ?? new Prisma.Decimal(loan.interestRatePm * 12)),
    arrearsCents: figures.arrearsIncludingCharges, penaltyRate: penalty.toString(), vatRateTenThousandths: vat.rateTenThousandths,
  })
  if (cpa) amount = { ...amount, penaltyCents: 0, invoiceExclVatCents: 0, invoiceVatCents: 0, totalCents: amount.arrearsCents }
  // Asking again the same day returns today's open quote while its figures still hold (no quote or audit rows on demand).
  const todays = await tx.leaseTerminationQuote.findFirst({
    where: {
      tenantId, loanId: loan.id, status: "QUOTED", quotedOn: dbDate(input.today), terminationDate: dbDate(terminationDate),
      remainingRentals: amount.remainingRentals, pvCents: amount.pvCents, arrearsCents: amount.arrearsCents, totalCents: amount.totalCents,
    },
    orderBy: { createdAt: "desc" }, select: { id: true, validUntil: true },
  })
  if (todays) return { kind: "quoted", quoteId: todays.id, totalCents: amount.totalCents, terminationDate, validUntil: isoOfDbDate(todays.validUntil) }
  const quote = await tx.leaseTerminationQuote.create({
    data: {
      tenantId, loanId: loan.id, quotedOn: dbDate(input.today), terminationDate: dbDate(terminationDate), validUntil: dbDate(validUntil), cpaCancellation: cpa,
      remainingRentals: amount.remainingRentals, pvCents: amount.pvCents, penaltyCents: amount.penaltyCents, arrearsCents: amount.arrearsCents,
      invoiceExclVatCents: amount.invoiceExclVatCents, invoiceVatCents: amount.invoiceVatCents, totalCents: amount.totalCents,
      basis: basisText(cpa, penalty.toString(), terminationDate), requestedByClientId: actor.clientId ?? null, createdById: actor.userId ?? null,
    },
    select: { id: true },
  })
  if (cpa) {
    // The notice is unilateral: suppress every future rental now, with no dependency on quote acceptance or valuation.
    await cancelFutureRentals(tx, { tenantId, loanId: loan.id, terminationDate, actorUserId: actor.userId ?? null })
    await tx.leaseEndOfTerm.create({ data: { tenantId, loanId: loan.id, origin: "EARLY_TERMINATION", outcome: "RETURN", status: "ELECTED", electedById: actor.userId ?? null, electedByClientId: actor.clientId ?? null } })
  }
  await logAuditStrict({
    tenantId, userId: actor.userId, action: AuditAction.LEASE_EARLY_TERMINATION_QUOTED, entity: "LeaseTerminationQuote", entityId: quote.id,
    newValue: { loanId: loan.id, terminationDate, validUntil, cpaCancellation: cpa, ...amount, clientId: actor.clientId ?? null },
  }, tx)
  return { kind: "quoted", quoteId: quote.id, totalCents: amount.totalCents, terminationDate, validUntil }
}

export async function acceptEarlyTermination(tx: SigningTx, actor: TerminationActor, input: { quoteId: string; today: string; assessment?: { goodsValueCents: number; costs: CancellationCost[]; reasonableAssessment?: unknown } }): Promise<TerminationResult> {
  const { tenantId } = actor
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "LeaseTerminationQuote" WHERE "id" = ${input.quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`)
  if (locked.length === 0) return { kind: "not_found" }
  const quote = await tx.leaseTerminationQuote.findFirstOrThrow({
    where: { id: input.quoteId, tenantId },
    include: { loan: { select: {
      reference: true, status: true, assetId: true, cpaApplies: true, leaseEndOfTerm: { select: { id: true } },
      entity: { select: { legalName: true, vatNumber: true, addressLine1: true, addressLine2: true, city: true, province: true, postalCode: true } },
      client: { select: { firstName: true, lastName: true, addressLine1: true, city: true, province: true, postalCode: true } },
      asset: { select: { make: true, model: true, year: true, serialNumber: true, vin: true } },
      assetFinanceDeal: { select: { earlyTerminationPenaltyRate: true } }, interestRatePm: true, contractRates: { orderBy: { effectiveDate: "desc" }, select: { resultingRate: true, effectiveDate: true } },
      leaseRentals: { where: { cancelledAt: null }, select: { dueDate: true, rentalExclVatCents: true } },
    } } },
  })
  if (await clientLeaseRefusal(actor, quote.loanId)) return { kind: "not_found" }
  if (quote.status !== "QUOTED") return refused("not_quoted", "The quote was already accepted")
  if (!quote.cpaCancellation && input.today > isoOfDbDate(quote.validUntil)) return refused("expired", `The quote expired on ${isoOfDbDate(quote.validUntil)}`)
  const { loan } = quote
  if (loan.leaseEndOfTerm && !quote.cpaCancellation) return refused("end_of_term", "The lease's end of term is already under way")
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED" && loan.status !== "COMPLETED") return refused("lease_closed", `The lease is ${loan.status}`)
  if (quote.cpaCancellation && (!actor.userId || !input.assessment)) return refused("valuation", "Staff must record the goods' net realisable or re-let value and documented actual costs; cancellation already stands")
  if (quote.cpaCancellation && input.assessment && (!Number.isSafeInteger(input.assessment.goodsValueCents) || input.assessment.goodsValueCents < 0
    || !Array.isArray(input.assessment.costs) || input.assessment.costs.some((c) => !c || !Number.isSafeInteger(c.amountCents) || c.amountCents < 0
      || typeof c.valuationNoOverlapEvidence !== "string" || !c.valuationNoOverlapEvidence.trim()
      || typeof c.description !== "string" || !c.description.trim() || typeof c.evidence !== "string" || !c.evidence.trim()))) {
    return refused("invalid_assessment", "Record a non-negative goods value and each actual cost with its description, amount, evidence and evidence confirming it was not deducted from the net goods valuation")
  }

  const acceptanceDate = quote.cpaCancellation ? isoOfDbDate(quote.terminationDate) : input.today
  const rate = Number(loan.contractRates.find((r) => isoOfDbDate(r.effectiveDate) <= acceptanceDate)?.resultingRate ?? new Prisma.Decimal(loan.interestRatePm * 12))
  // CPA rentals were cancelled at notice: retain those rows for the valuation calculation.
  const assessmentRentals = quote.cpaCancellation
    ? await tx.leaseRental.findMany({ where: { tenantId, loanId: quote.loanId, dueDate: { gt: quote.terminationDate } }, select: { dueDate: true, rentalExclVatCents: true } })
    : loan.leaseRentals
  const now = earlyTerminationAmount({
    rentals: assessmentRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })),
    terminationDate: acceptanceDate, annualRate: rate,
    arrearsCents: 0, penaltyRate: "0", vatRateTenThousandths: 0,
  })
  const vat = await loadRateOn(tx, input.today)
  const costs = input.assessment?.costs ?? []
  const cpaCharge = quote.cpaCancellation && input.assessment ? cpaCancellationCharge({
    rentals: assessmentRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })),
    terminationDate: acceptanceDate, annualRate: rate, goodsValueCents: input.assessment.goodsValueCents, costs,
  }) : null
  let reasonableAssessment: ReturnType<typeof assessReasonableCancellation> | null = null
  if (cpaCharge) {
    try { reasonableAssessment = assessReasonableCancellation(input.assessment?.reasonableAssessment, cpaCharge.chargeCents) }
    catch (error) { return refused("reasonable_assessment", error instanceof Error ? error.message : "A reasoned Regulation 5 assessment is required") }
  }
  const priced = quote.cpaCancellation ? { pvCents: now.pvCents, penaltyCents: 0, invoiceExclVatCents: reasonableAssessment!.assessedChargeCents,
    invoiceVatCents: Math.round(reasonableAssessment!.assessedChargeCents * vat.rateTenThousandths / 10000) }
    : earlyTerminationAmount({ rentals: assessmentRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })), terminationDate: acceptanceDate,
      annualRate: rate, arrearsCents: quote.arrearsCents, penaltyRate: loan.assetFinanceDeal?.earlyTerminationPenaltyRate?.toString() ?? "0", vatRateTenThousandths: vat.rateTenThousandths })
  // Commercial termination is priced at acceptance, never backdated to the quote date.
  Object.assign(quote, priced, { terminationDate: dbDate(acceptanceDate), totalCents: priced.invoiceExclVatCents + priced.invoiceVatCents + quote.arrearsCents })
  const lessee = loan.entity ?? loan.client
  const address = lessee ? recipientAddress(lessee) : null
  if (quote.invoiceExclVatCents > 0 && (!lessee || !address || !loan.asset)) return refused("recipient", "The lessee's name and address are needed on the tax invoice")
  let taxInvoiceId: string | null = null
  let scheduleId: string | null = null
  let invoice: Awaited<ReturnType<typeof issueTaxInvoice>> | null = null
  if (quote.invoiceExclVatCents > 0) {
    if (!lessee || !address || !loan.asset) return refused("recipient", "The lessee's name and address are needed on the tax invoice")
    const what = `lease ${loan.reference} (${describeAsset(loan.asset)}), terminated ${isoOfDbDate(quote.terminationDate)}`
    invoice = await issueTaxInvoice(tx, {
      tenantId, loanId: quote.loanId, issueDate: input.today, supplyDate: input.today, createdById: actor.userId ?? null,
      recipient: { name: loan.entity?.legalName ?? `${loan.client?.firstName ?? ""} ${loan.client?.lastName ?? ""}`.trim(), address, vatNumber: loan.entity?.vatNumber ?? null },
      lines: [
        ...(quote.cpaCancellation ? (quote.invoiceExclVatCents > 0 ? [{ description: `CPA cancellation: PV ${formatMoney(quote.pvCents)} less goods ${formatMoney(input.assessment!.goodsValueCents)} plus documented costs ${formatMoney(cpaCharge!.costsCents)} (financial ceiling ${formatMoney(cpaCharge!.chargeCents)}; assessed reasonable charge ${formatMoney(quote.invoiceExclVatCents)}), ${what}. ${costs.map((c) => `${c.description}: ${formatMoney(c.amountCents)}, evidence ${c.evidence}`).join("; ")}`, quantity: 1, unitExclVatCents: quote.invoiceExclVatCents }] : [])
          : (quote.pvCents > 0 ? [{ description: `Early termination: present value of the remaining rentals, ${what}`, quantity: 1, unitExclVatCents: quote.pvCents }] : [])),
        ...(quote.penaltyCents > 0 ? [{ description: `Early-termination penalty, ${what}`, quantity: 1, unitExclVatCents: quote.penaltyCents }] : []),
      ],
    })
    if (invoice.totalInclVatCents !== quote.invoiceExclVatCents + quote.invoiceVatCents) throw new Error(`termination invoice ${invoice.invoiceNumber} does not match the quote`)
    taxInvoiceId = invoice.id
  }
  if (!quote.cpaCancellation) await cancelFutureRentals(tx, { tenantId, loanId: quote.loanId, terminationDate: isoOfDbDate(quote.terminationDate), actorUserId: actor.userId ?? null })
  if (invoice) {
    scheduleId = await appendLeaseCharge(tx, { tenantId, loanId: quote.loanId, amountCents: invoice.totalInclVatCents, dueDate: isoOfDbDate(quote.terminationDate), actorUserId: actor.userId ?? null, why: "lease_early_termination" })
  }
  await tx.leaseTerminationQuote.update({ where: { id: quote.id, tenantId }, data: { ...priced, terminationDate: quote.terminationDate, totalCents: quote.totalCents,
    ...(quote.cpaCancellation ? { goodsValueCents: input.assessment!.goodsValueCents, documentedCosts: costs as unknown as Prisma.InputJsonValue, reasonableAssessment: reasonableAssessment as unknown as Prisma.InputJsonValue, basis: basisText(true, "0", acceptanceDate) + ` Reasonable charge: ${formatMoney(reasonableAssessment!.assessedChargeCents)}; financial ceiling: ${formatMoney(reasonableAssessment!.ceilingCents)}. Assessment: ${reasonableAssessment!.rationale}. Cancellation remains available: ${reasonableAssessment!.cancellationRightReason}. Recorded goods value: ${formatMoney(input.assessment!.goodsValueCents)}; costs: ${costs.map((c) => `${c.description}: ${formatMoney(c.amountCents)} (${c.evidence}; not deducted from goods valuation: ${c.valuationNoOverlapEvidence})`).join("; ") || "none"}.` } : {}),
    status: "ACCEPTED", acceptedAt: new Date(), acceptedById: actor.userId ?? null, acceptedByClientId: actor.clientId ?? null, taxInvoiceId, scheduleId } })
  if (!quote.cpaCancellation) await tx.leaseEndOfTerm.create({ data: { tenantId, loanId: quote.loanId, origin: "EARLY_TERMINATION", outcome: "RETURN", status: "ELECTED", electedById: actor.userId ?? null, electedByClientId: actor.clientId ?? null } })
  await replayLeaseCancellationCredit(tx, { tenantId, loanId: quote.loanId, userId: actor.userId ?? null, reference: quote.id })
  await logAuditStrict({
    tenantId, userId: actor.userId, action: AuditAction.LEASE_EARLY_TERMINATION_ACCEPTED, entity: "LeaseTerminationQuote", entityId: quote.id,
    newValue: { loanId: quote.loanId, taxInvoiceId, scheduleId, totalCents: quote.totalCents, terminationDate: isoOfDbDate(quote.terminationDate), clientId: actor.clientId ?? null, ...(quote.cpaCancellation ? { goodsValueCents: input.assessment!.goodsValueCents, documentedCosts: costs, reasonableAssessment } : {}) },
  }, tx)
  return { kind: "accepted", quoteId: quote.id, taxInvoiceId }
}
