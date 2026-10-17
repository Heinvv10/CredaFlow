/**
 * Early termination of a lease (slice 3, C8), in the caller's transaction.
 *
 * QUOTE (staff or the lessee in the portal): the 2a.4 amount (./lease-termination.ts)
 * on a termination date of today, or, for a CPA lessee giving notice, 20
 * business days after it (CPA s14). Valid TenantConfig.leaseTerminationQuoteValidDays.
 * The basis printed with it explains the formula and, for a CPA lessee, the
 * Reg 5(2) factors a "reasonable cancellation penalty" must weigh.
 * The formula and the penalty: signed off (see DESIGN.md sign-off record 2026-10-17).
 *
 * ACCEPT (within validity, once per lease; guardLeaseTerminationQuote and a
 * partial unique index): the uninvoiced rentals after the termination date
 * are cancelled (./lease-charges.ts); the PV and the penalty are invoiced, a
 * line each (VAT treatment signed off, see DESIGN.md sign-off record 2026-10-17), and the invoice becomes a schedule row;
 * a RETURN end of term (origin EARLY_TERMINATION) is opened for the
 * inspection (./lease-end-of-term.ts). The loan closes once paid
 * (./lease-end-invoice.ts completeEndOfTermIfSettled, after the return).
 * Accepting re-prices the quote: if the remaining rentals changed since (one
 * was invoiced, cancelled or repriced) the present value differs and the
 * quote is refused as stale; so is a lease no longer running.
 */
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { describeAsset, issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { loadRateOn } from "@/lib/vat/vat-rate"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { recipientAddress } from "./booking-load"
import { dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
import { appendLeaseCharge, cancelFutureRentals } from "./lease-charges"
import { cpaCancellationDate, earlyTerminationAmount } from "./lease-termination"
import type { SigningTx } from "./signing-prepare"
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
  const formula = `Present value of the rentals (ex VAT and maintenance) falling due after ${terminationDate}, discounted at the contract rate, `
    + `plus a penalty of ${(Number(penaltyRate) * 100).toFixed(2)}% of that present value, plus the arrears. The asset is returned; no credit is given for its resale value.`
  return cpa
    ? `${formula} The lessee is a consumer under the CPA: cancellation on 20 business days' notice (s14(2)(b)(i)(bb)); the penalty is limited to a reasonable cancellation penalty, weighing ${REG5_FACTORS}.`
    : formula
}

export async function quoteEarlyTermination(tx: SigningTx, actor: TerminationActor, input: { loanId: string; today: string }): Promise<TerminationResult> {
  const { tenantId } = actor
  const denied = await clientLeaseRefusal(actor, input.loanId)
  if (denied) return denied
  const loan = await tx.loan.findFirst({
    where: { id: input.loanId, tenantId, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } },
    select: {
      id: true, status: true, cpaApplies: true, interestRatePm: true, totalRepayable: true, totalPaid: true, outstandingPrincipal: true, arrearsAmount: true, tenantId: true, principal: true, totalInterest: true, interestModel: true, startDate: true, maturityDate: true,
      contractualTotalInterest: true, contractualTotalRepayable: true,
      repaymentSchedule: true, leaseEndOfTerm: { select: { id: true } }, assetFinanceDeal: { select: { earlyTerminationPenaltyRate: true } },
      leaseRentals: { where: { cancelledAt: null, taxInvoiceId: null }, select: { dueDate: true, rentalExclVatCents: true } },
      contractRates: { orderBy: { effectiveDate: "desc" }, take: 1, select: { resultingRate: true } },
    },
  })
  if (!loan) return { kind: "not_found" }
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") return refused("lease_closed", `The lease is ${loan.status}`)
  if (loan.leaseEndOfTerm) return refused("end_of_term", "The lease's end of term is already under way")
  const penalty = loan.assetFinanceDeal?.earlyTerminationPenaltyRate
  if (!penalty) return refused("penalty", "The lease has no early-termination penalty rate")
  const cpa = loan.cpaApplies === true
  const terminationDate = cpa ? cpaCancellationDate(input.today) : input.today
  const config = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { leaseTerminationQuoteValidDays: true } })
  const validUntil = fromDayNumber(toDayNumber(input.today) + (config?.leaseTerminationQuoteValidDays ?? 10))
  const figures = await loanSettlementFigures(tx, loan, new Date())
  const vat = await loadRateOn(tx, input.today)
  const amount = earlyTerminationAmount({
    rentals: loan.leaseRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })),
    terminationDate, annualRate: Number(loan.contractRates[0]?.resultingRate ?? new Prisma.Decimal(loan.interestRatePm * 12)),
    arrearsCents: figures.arrearsIncludingCharges, penaltyRate: penalty.toString(), vatRateTenThousandths: vat.rateTenThousandths,
  })
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
  await logAuditStrict({
    tenantId, userId: actor.userId, action: AuditAction.LEASE_EARLY_TERMINATION_QUOTED, entity: "LeaseTerminationQuote", entityId: quote.id,
    newValue: { loanId: loan.id, terminationDate, validUntil, cpaCancellation: cpa, ...amount, clientId: actor.clientId ?? null },
  }, tx)
  return { kind: "quoted", quoteId: quote.id, totalCents: amount.totalCents, terminationDate, validUntil }
}

export async function acceptEarlyTermination(tx: SigningTx, actor: TerminationActor, input: { quoteId: string; today: string }): Promise<TerminationResult> {
  const { tenantId } = actor
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "LeaseTerminationQuote" WHERE "id" = ${input.quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`)
  if (locked.length === 0) return { kind: "not_found" }
  const quote = await tx.leaseTerminationQuote.findFirstOrThrow({
    where: { id: input.quoteId, tenantId },
    include: { loan: { select: {
      reference: true, status: true, assetId: true, leaseEndOfTerm: { select: { id: true } },
      entity: { select: { legalName: true, vatNumber: true, addressLine1: true, addressLine2: true, city: true, province: true, postalCode: true } },
      client: { select: { firstName: true, lastName: true, addressLine1: true, city: true, province: true, postalCode: true } },
      asset: { select: { make: true, model: true, year: true, serialNumber: true, vin: true } },
      interestRatePm: true, contractRates: { orderBy: { effectiveDate: "desc" }, take: 1, select: { resultingRate: true } },
      leaseRentals: { where: { cancelledAt: null, taxInvoiceId: null }, select: { dueDate: true, rentalExclVatCents: true } },
    } } },
  })
  if (await clientLeaseRefusal(actor, quote.loanId)) return { kind: "not_found" }
  if (quote.status !== "QUOTED") return refused("not_quoted", "The quote was already accepted")
  if (input.today > isoOfDbDate(quote.validUntil)) return refused("expired", `The quote expired on ${isoOfDbDate(quote.validUntil)}`)
  const { loan } = quote
  if (loan.leaseEndOfTerm) return refused("end_of_term", "The lease's end of term is already under way")
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") return refused("lease_closed", `The lease is ${loan.status}`)
  const now = earlyTerminationAmount({
    rentals: loan.leaseRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })),
    terminationDate: isoOfDbDate(quote.terminationDate), annualRate: Number(loan.contractRates[0]?.resultingRate ?? new Prisma.Decimal(loan.interestRatePm * 12)),
    arrearsCents: 0, penaltyRate: "0", vatRateTenThousandths: 0,
  })
  if (now.remainingRentals !== quote.remainingRentals || now.pvCents !== quote.pvCents) {
    return refused("stale_quote", "The rentals changed since the quote; ask for a new quote")
  }
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
        ...(quote.pvCents > 0 ? [{ description: `Early termination: present value of the remaining rentals, ${what}`, quantity: 1, unitExclVatCents: quote.pvCents }] : []),
        ...(quote.penaltyCents > 0 ? [{ description: `Early-termination penalty, ${what}`, quantity: 1, unitExclVatCents: quote.penaltyCents }] : []),
      ],
    })
    if (invoice.totalInclVatCents !== quote.invoiceExclVatCents + quote.invoiceVatCents) throw new Error(`termination invoice ${invoice.invoiceNumber} does not match the quote`)
    taxInvoiceId = invoice.id
  }
  await cancelFutureRentals(tx, { tenantId, loanId: quote.loanId, terminationDate: isoOfDbDate(quote.terminationDate), actorUserId: actor.userId ?? null })
  if (invoice) {
    scheduleId = await appendLeaseCharge(tx, { tenantId, loanId: quote.loanId, amountCents: invoice.totalInclVatCents, dueDate: isoOfDbDate(quote.terminationDate), actorUserId: actor.userId ?? null, why: "lease_early_termination" })
  }
  await tx.leaseTerminationQuote.update({ where: { id: quote.id, tenantId }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: actor.userId ?? null, acceptedByClientId: actor.clientId ?? null, taxInvoiceId, scheduleId } })
  await tx.leaseEndOfTerm.create({ data: { tenantId, loanId: quote.loanId, origin: "EARLY_TERMINATION", outcome: "RETURN", status: "ELECTED", electedById: actor.userId ?? null, electedByClientId: actor.clientId ?? null } })
  await logAuditStrict({
    tenantId, userId: actor.userId, action: AuditAction.LEASE_EARLY_TERMINATION_ACCEPTED, entity: "LeaseTerminationQuote", entityId: quote.id,
    newValue: { loanId: quote.loanId, taxInvoiceId, scheduleId, totalCents: quote.totalCents, terminationDate: isoOfDbDate(quote.terminationDate), clientId: actor.clientId ?? null },
  }, tx)
  return { kind: "accepted", quoteId: quote.id, taxInvoiceId }
}
