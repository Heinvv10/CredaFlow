/**
 * The end of a lease's term (slice 3, C7), in the caller's transaction. One
 * LeaseEndOfTerm per lease; its outcome never changes (guardLeaseEndOfTerm,
 * migration 20261014100000, refuses a second outcome and every transition
 * not listed below; these checks are the readable refusal).
 *
 *   RETURN    ELECTED → INSPECTED (condition, damage, final reading) → INVOICED → COMPLETED
 *   EXTEND    EXTENDING (month to month; ./lease-extension.ts appends each
 *             rental) → notice by either party ends it one month later →
 *             INSPECTED → INVOICED → COMPLETED, as a return
 *   PURCHASE  ELECTED (price ≥ a valuation of the asset dated within the
 *             tenant's days) → INVOICED (sale tax invoice) → COMPLETED
 *             (paid, eNaTIS change confirmed on a registered asset)
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
import { addMonthsClamped, dbDate, isoOfDbDate, toDayNumber } from "./dates"
import { recordMeterReading } from "./meter-readings"
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
    select: { status: true, assetId: true, maturityDate: true, leaseEndOfTerm: { select: { id: true, outcome: true } } },
  })
  if (!loan?.assetId) return { kind: "not_found" }
  if (loan.leaseEndOfTerm) return refused("already_elected", `The end of term is already ${loan.leaseEndOfTerm.outcome}`)
  if (loan.status !== "ACTIVE" && loan.status !== "COMPLETED" && loan.status !== "DEFAULTED") return refused("lease_closed", `The lease is ${loan.status}`)
  const lastRental = sastCalendarDate(loan.maturityDate)
  if (input.today < addMonthsClamped(lastRental, -ELECTION_WINDOW_MONTHS)) {
    return refused("too_early", `The end-of-term choice opens ${ELECTION_WINDOW_MONTHS} months before the last rental (${lastRental})`)
  }
  let purchase = {}
  if (input.outcome === "PURCHASE") {
    if (!input.purchase) return refused("purchase_terms", "A purchase needs its price and the valuation it rests on")
    const config = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { leasePurchaseValuationMaxAgeDays: true } })
    const maxAge = config?.leasePurchaseValuationMaxAgeDays ?? 30
    const valuation = await tx.assetValuation.findFirst({ where: { id: input.purchase.valuationId, tenantId, assetId: loan.assetId }, select: { valuedOn: true, amountCents: true } })
    if (!valuation) return refused("valuation", "The valuation is not of this asset")
    if (toDayNumber(isoOfDbDate(valuation.valuedOn)) < toDayNumber(input.today) - maxAge) return refused("valuation_stale", `The valuation must be dated within ${maxAge} days`)
    if (input.purchase.priceExclVatCents < valuation.amountCents) return refused("below_market", `The price may not be below the market value of ${valuation.amountCents} cents ex VAT`)
    purchase = { purchasePriceExclVatCents: input.purchase.priceExclVatCents, purchaseValuationId: input.purchase.valuationId }
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

/** Either party ends a month-to-month extension: it ends EXTENSION_NOTICE_MONTHS after the notice date. */
export async function endExtension(tx: SigningTx, actor: EndActor, input: { loanId: string; noticeOn: string }): Promise<EndResult> {
  const denied = await clientLeaseRefusal(actor, input.loanId)
  if (denied) return denied
  const row = await tx.leaseEndOfTerm.findFirst({ where: { tenantId: actor.tenantId, loanId: input.loanId }, select: { id: true, status: true, extensionNoticeOn: true } })
  if (!row) return { kind: "not_found" }
  if (row.status !== "EXTENDING") return refused("not_extending", "The lease is not on a month-to-month extension")
  if (row.extensionNoticeOn) return refused("notice_given", `Notice was given on ${isoOfDbDate(row.extensionNoticeOn)}`)
  const endsOn = addMonthsClamped(input.noticeOn, EXTENSION_NOTICE_MONTHS)
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
    select: { id: true, status: true, outcome: true, extensionEndsOn: true, loan: { select: { assetFinanceDeal: { select: { usageUnit: true } } } } },
  })
  if (!row) return { kind: "not_found" }
  const extensionOver = row.status === "EXTENDING" && row.extensionEndsOn !== null && isoOfDbDate(row.extensionEndsOn) <= input.today
  if (!(row.status === "ELECTED" && row.outcome === "RETURN") && !extensionOver) {
    return refused("not_returnable", row.status === "EXTENDING" ? "The extension has not ended yet" : `An inspection follows a return, not ${row.outcome} ${row.status}`)
  }
  if (input.condition.trim().length < 3) return refused("condition", "Describe the asset's condition")
  if (input.damage.some((d) => d.description.trim().length < 3 || !Number.isSafeInteger(d.amountExclVatCents) || d.amountExclVatCents <= 0)) {
    return refused("damage", "Each damage item needs a description and a positive amount")
  }
  const unit = row.loan.assetFinanceDeal?.usageUnit ?? null
  let finalReadingId: string | null = null
  if (unit !== null) {
    if (input.finalReading === null) return refused("final_reading", "Record the final meter reading: the lease has contracted usage")
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
