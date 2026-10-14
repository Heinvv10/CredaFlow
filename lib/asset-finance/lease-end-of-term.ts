/**
 * The end of a lease's term (slice 3, C7), in the caller's transaction. One
 * LeaseEndOfTerm per lease; its outcome never changes (guardLeaseEndOfTerm,
 * migration 20261014100000, refuses a second outcome and every transition
 * not listed below; these checks are the readable refusal).
 *
 *   RETURN    ELECTED → INSPECTED (condition, damage, final reading) → INVOICED → COMPLETED
 *   EXTEND    EXTENDING (month to month; the daily run, ./lease-daily.ts,
 *             appends each rental) → notice by either party ends it one month later →
 *             INSPECTED → INVOICED → COMPLETED, as a return
 *   PURCHASE  ELECTED (price ≥ a market valuation, ./lease-term-end.ts; electing
 *             again while ELECTED re-bases it on a newer valuation) →
 *             INVOICED (sale tax invoice, once the term has ended) → COMPLETED
 *             (paid, eNaTIS change confirmed on a registered asset)
 * A return is inspected only once the term has ended (an early termination's
 * from its termination date), with the final reading as the latest reading.
 * Invoicing and completion are ./lease-end-invoice.ts. Staff or the lessee
 * (portal) elects; staff inspect. Audited.
 *
 * // UNTESTED: tax/legal — the purchase option must not recharacterise the
 * operating lease as a finance lease: the price is market value on a dated
 * valuation, never a price fixed in the agreement.
 */
import type { LeaseEndOutcome } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped, dbDate, isoOfDbDate } from "./dates"
import { recordMeterReading } from "./meter-readings"
import { checkPurchaseValuation, leaseTermEnd } from "./lease-term-end"
import { clientLeaseRefusal } from "./lease-portal-route"
import type { SigningTx } from "./signing-prepare"

export type EndActor = { tenantId: string; userId: string; clientId?: undefined } | { tenantId: string; clientId: string; userId?: undefined }

export type EndResult =
  | { kind: "ok"; endOfTermId: string; status: string }
  | { kind: "not_found" }
  | { kind: "refused"; reason: string; error: string }

const refused = (reason: string, error: string): EndResult => ({ kind: "refused", reason, error })
const audit = (tx: SigningTx, actor: EndActor, action: string, entityId: string, newValue: Record<string, unknown>) =>
  logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action, entity: "LeaseEndOfTerm", entityId, newValue: { ...newValue, clientId: actor.clientId ?? null } }, tx)

/** Months before the last rental that the end-of-term choice opens. */
export const ELECTION_WINDOW_MONTHS = 6
/** A month-to-month extension ends this many months after notice. // UNTESTED: legal — notice period. */
export const EXTENSION_NOTICE_MONTHS = 1

export interface ElectInput {
  loanId: string
  outcome: LeaseEndOutcome
  today: string
  purchase?: { priceExclVatCents: number; valuationId: string }
}

export async function electEndOfTerm(tx: SigningTx, actor: EndActor, input: ElectInput): Promise<EndResult> {
  const { tenantId } = actor
  // A portal client acts only on a lease they are the lessee of, or have authority for.
  const denied = await clientLeaseRefusal(actor, input.loanId)
  if (denied) return denied
  const loan = await tx.loan.findFirst({
    where: { id: input.loanId, tenantId, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } },
    select: { status: true, assetId: true, maturityDate: true, leaseEndOfTerm: { select: { id: true, outcome: true, status: true } } },
  })
  if (!loan?.assetId) return { kind: "not_found" }
  const rebase = loan.leaseEndOfTerm?.outcome === "PURCHASE" && loan.leaseEndOfTerm.status === "ELECTED" && input.outcome === "PURCHASE"
  if (loan.leaseEndOfTerm && !rebase) return refused("already_elected", `The end of term is already ${loan.leaseEndOfTerm.outcome}`)
  if (loan.status !== "ACTIVE" && loan.status !== "COMPLETED" && loan.status !== "DEFAULTED") return refused("lease_closed", `The lease is ${loan.status}`)
  if (input.outcome === "EXTEND" && loan.status === "DEFAULTED") return refused("defaulted", "A lease in default is not extended")
  const lastRental = sastCalendarDate(loan.maturityDate)
  if (input.today < addMonthsClamped(lastRental, -ELECTION_WINDOW_MONTHS)) {
    return refused("too_early", `The end-of-term choice opens ${ELECTION_WINDOW_MONTHS} months before the last rental (${lastRental})`)
  }
  let purchase = {}
  if (input.outcome === "PURCHASE") {
    if (!input.purchase) return refused("purchase_terms", "A purchase needs its price and the valuation it rests on")
    const valuation = await checkPurchaseValuation(tx, { tenantId, assetId: loan.assetId, valuationId: input.purchase.valuationId, today: input.today, electorUserId: actor.userId ?? null })
    if (!valuation.ok) return refused(valuation.reason, valuation.error)
    if (input.purchase.priceExclVatCents < valuation.amountCents) return refused("below_market", `The price may not be below the market value of ${valuation.amountCents} cents ex VAT`)
    purchase = { purchasePriceExclVatCents: input.purchase.priceExclVatCents, purchaseValuationId: input.purchase.valuationId }
  }
  if (rebase && loan.leaseEndOfTerm) {
    // A purchase elected early is re-based on a current valuation before it is invoiced (the old one may have aged out).
    // The re-baser becomes the elector: the database checks the valuation's four-eyes against them.
    const row = await tx.leaseEndOfTerm.update({
      where: { id: loan.leaseEndOfTerm.id, tenantId },
      data: { ...purchase, electedById: actor.userId ?? null, electedByClientId: actor.clientId ?? null }, select: { id: true, status: true },
    })
    await audit(tx, actor, AuditAction.LEASE_END_OF_TERM_ELECTED, row.id, { loanId: input.loanId, outcome: input.outcome, rebased: true, ...purchase })
    return { kind: "ok", endOfTermId: row.id, status: row.status }
  }
  const row = await tx.leaseEndOfTerm.create({
    data: {
      tenantId, loanId: input.loanId, origin: "EXPIRY", outcome: input.outcome, status: input.outcome === "EXTEND" ? "EXTENDING" : "ELECTED",
      electedById: actor.userId ?? null, electedByClientId: actor.clientId ?? null, ...purchase,
    },
    select: { id: true, status: true },
  })
  await audit(tx, actor, AuditAction.LEASE_END_OF_TERM_ELECTED, row.id, { loanId: input.loanId, outcome: input.outcome, ...purchase })
  return { kind: "ok", endOfTermId: row.id, status: row.status }
}

/** Either party ends a month-to-month extension: EXTENSION_NOTICE_MONTHS after the notice, or when the billed period ends if later. */
export async function endExtension(tx: SigningTx, actor: EndActor, input: { loanId: string; noticeOn: string; today: string }): Promise<EndResult> {
  const denied = await clientLeaseRefusal(actor, input.loanId)
  if (denied) return denied
  const row = await tx.leaseEndOfTerm.findFirst({ where: { tenantId: actor.tenantId, loanId: input.loanId }, select: { id: true, status: true, extensionNoticeOn: true, electedAt: true } })
  if (!row) return { kind: "not_found" }
  if (row.status !== "EXTENDING") return refused("not_extending", "The lease is not on a month-to-month extension")
  if (row.extensionNoticeOn) return refused("notice_given", `Notice was given on ${isoOfDbDate(row.extensionNoticeOn)}`)
  const electedOn = sastCalendarDate(row.electedAt)
  if (input.noticeOn < electedOn || input.noticeOn > input.today) return refused("invalid_notice_date", `Notice is dated between the election (${electedOn}) and today`)
  // Never before the end of the period already billed (./lease-term-end.ts: a month after the last rental in advance).
  const termEnd = await leaseTermEnd(tx, actor.tenantId, input.loanId)
  const noticeEnds = addMonthsClamped(input.noticeOn, EXTENSION_NOTICE_MONTHS)
  const endsOn = termEnd && termEnd > noticeEnds ? termEnd : noticeEnds
  await tx.leaseEndOfTerm.update({ where: { id: row.id, tenantId: actor.tenantId }, data: { extensionNoticeOn: dbDate(input.noticeOn), extensionEndsOn: dbDate(endsOn) } })
  await audit(tx, actor, AuditAction.LEASE_EXTENSION_ENDED, row.id, { loanId: input.loanId, noticeOn: input.noticeOn, endsOn })
  return { kind: "ok", endOfTermId: row.id, status: "EXTENDING" }
}

export interface InspectionInput {
  loanId: string
  inspectedOn: string
  condition: string
  finalReading: number | null
  damage: { description: string; amountExclVatCents: number }[]
  today: string
}

/** The return inspection: condition, damage items with assessed amounts, the final meter reading. */
export async function recordInspection(tx: SigningTx, actor: { tenantId: string; userId: string }, input: InspectionInput): Promise<EndResult> {
  const { tenantId } = actor
  const row = await tx.leaseEndOfTerm.findFirst({
    where: { tenantId, loanId: input.loanId },
    select: {
      id: true, status: true, outcome: true, origin: true, electedAt: true, extensionEndsOn: true,
      loan: { select: { assetFinanceDeal: { select: { usageUnit: true } }, leaseTerminationQuotes: { where: { status: "ACCEPTED" }, select: { terminationDate: true } } } },
    },
  })
  if (!row) return { kind: "not_found" }
  const extensionOver = row.status === "EXTENDING" && row.extensionEndsOn !== null && isoOfDbDate(row.extensionEndsOn) <= input.today
  if (!(row.status === "ELECTED" && row.outcome === "RETURN") && !extensionOver) {
    return refused("not_returnable", row.status === "EXTENDING" ? "The extension has not ended yet" : `An inspection follows a return, not ${row.outcome} ${row.status}`)
  }
  // The asset comes back when the term ends: never inspected before that, never in the future, never before the election.
  const returnsOn = row.origin === "EARLY_TERMINATION"
    ? (row.loan.leaseTerminationQuotes[0] ? isoOfDbDate(row.loan.leaseTerminationQuotes[0].terminationDate) : null)
    : row.extensionEndsOn ? isoOfDbDate(row.extensionEndsOn) : await leaseTermEnd(tx, tenantId, input.loanId)
  if (returnsOn === null) return { kind: "not_found" }
  if (input.inspectedOn > input.today || input.inspectedOn < sastCalendarDate(row.electedAt)) return refused("invalid_inspectedOn", "The inspection is dated between the election and today")
  if (input.inspectedOn < returnsOn) return refused("term_running", `The asset is returned on ${returnsOn}: inspect it from then`)
  if (input.condition.trim().length < 3) return refused("condition", "Describe the asset's condition")
  if (input.damage.some((d) => d.description.trim().length < 3 || !Number.isSafeInteger(d.amountExclVatCents) || d.amountExclVatCents <= 0)) {
    return refused("damage", "Each damage item needs a description and a positive amount")
  }
  const unit = row.loan.assetFinanceDeal?.usageUnit ?? null
  let finalReadingId: string | null = null
  if (unit !== null) {
    if (input.finalReading === null) return refused("final_reading", "Record the final meter reading: the lease has contracted usage")
    // The final reading is the latest: excess is billed from it.
    const later = await tx.assetMeterReading.findFirst({ where: { tenantId, loanId: input.loanId, unit, readingDate: { gt: dbDate(input.inspectedOn) } }, select: { readingDate: true } })
    if (later) return refused("invalid_inspectedOn", `A reading dated ${isoOfDbDate(later.readingDate)} is later than the inspection`)
    const reading = await recordMeterReading(tx, { tenantId, userId: actor.userId }, {
      loanId: input.loanId, readingDate: input.inspectedOn, value: input.finalReading, evidenceDocumentId: null, today: input.today,
    })
    if (reading.kind === "refused") return refused(reading.reason, reading.error)
    if (reading.kind === "not_found") return { kind: "not_found" }
    finalReadingId = reading.readingId
  }
  await tx.leaseEndOfTerm.update({
    where: { id: row.id, tenantId },
    data: { status: "INSPECTED", inspectedOn: dbDate(input.inspectedOn), inspectionCondition: input.condition.trim(), inspectedById: actor.userId, finalReadingId },
  })
  if (input.damage.length > 0) {
    await tx.leaseDamageItem.createMany({
      data: input.damage.map((d) => ({ tenantId, endOfTermId: row.id, description: d.description.trim(), amountExclVatCents: d.amountExclVatCents })),
    })
  }
  await audit(tx, actor, AuditAction.LEASE_INSPECTION_RECORDED, row.id, {
    loanId: input.loanId, inspectedOn: input.inspectedOn, finalReadingId, damage: input.damage,
  })
  return { kind: "ok", endOfTermId: row.id, status: "INSPECTED" }
}
