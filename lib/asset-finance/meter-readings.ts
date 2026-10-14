/**
 * Meter readings of a leased asset (slice 3, C6), staff or portal, in the
 * caller's transaction. The unit is the lease's contracted unit (hours or km).
 * Readings are monotonic per asset and unit: a reading may not be below an
 * earlier-dated one nor above a later-dated one, and is immutable
 * (guardAssetMeterReading, migration 20261014100000); the check here is the
 * readable refusal. Because a reading caps every later one, a lessee's portal
 * reading may not run ahead of PORTAL_PACE_LIMIT times the contracted pace
 * (plus a month's allowance) since the lease's start reading; staff record
 * anything larger, with evidence. Audited.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import type { SigningTx } from "./signing-prepare"
import { clientLeaseRefusal } from "./lease-portal-route"

/** A portal reading may run at most this many times the contracted pace since the lease's start reading. */
export const PORTAL_PACE_LIMIT = 3

export type ReadingActor = { tenantId: string; userId: string; clientId?: undefined } | { tenantId: string; clientId: string; userId?: undefined }

export type ReadingResult =
  | { kind: "recorded"; readingId: string }
  | { kind: "not_found" }
  | { kind: "refused"; reason: string; error: string }

export interface ReadingInput {
  loanId: string
  readingDate: string
  value: number
  evidenceDocumentId: string | null
  today: string
}

export async function recordMeterReading(tx: SigningTx, actor: ReadingActor, input: ReadingInput): Promise<ReadingResult> {
  const { tenantId } = actor
  const loan = await tx.loan.findFirst({
    where: { id: input.loanId, tenantId, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } },
    select: { assetId: true, status: true, startDate: true, assetFinanceDeal: { select: { id: true, usageUnit: true, usageAllowancePerYear: true } } },
  })
  const unit = loan?.assetFinanceDeal?.usageUnit
  if (!loan?.assetId || !unit) return { kind: "not_found" }
  if (actor.clientId) {
    // The portal: the lessee (or the entity's authorised people), on a running lease only.
    if (await clientLeaseRefusal(actor, input.loanId)) return { kind: "not_found" }
    if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") return { kind: "refused", reason: "lease_closed", error: `The lease is ${loan.status}` }
    // A lessee reports today's reading only: no backdating into another period,
    // and never before the lease started. Staff record dated readings.
    if (input.readingDate !== input.today) return { kind: "refused", reason: "reading_date", error: "A reading from the portal is today's" }
  }
  try {
    toDayNumber(input.readingDate, "readingDate")
  } catch {
    return { kind: "refused", reason: "reading_date", error: "The reading date must be a calendar date YYYY-MM-DD" }
  }
  if (input.readingDate > input.today) return { kind: "refused", reason: "reading_date", error: "A reading cannot be dated in the future" }
  if (input.readingDate < sastCalendarDate(loan.startDate)) return { kind: "refused", reason: "reading_date", error: "A reading cannot predate the lease" }
  if (!Number.isSafeInteger(input.value) || input.value < 0) return { kind: "refused", reason: "value", error: "The reading must be a whole number of hours or km" }
  const [before, after] = await Promise.all([
    tx.assetMeterReading.findFirst({ where: { tenantId, assetId: loan.assetId, unit, readingDate: { lte: dbDate(input.readingDate) } }, orderBy: [{ readingDate: "desc" }, { value: "desc" }], select: { value: true, readingDate: true } }),
    tx.assetMeterReading.findFirst({ where: { tenantId, assetId: loan.assetId, unit, readingDate: { gt: dbDate(input.readingDate) } }, orderBy: [{ readingDate: "asc" }, { value: "asc" }], select: { value: true } }),
  ])
  if (before && input.value < before.value) return { kind: "refused", reason: "not_monotonic", error: `The reading may not be below an earlier one (${before.value})` }
  if (after && input.value > after.value) return { kind: "refused", reason: "not_monotonic", error: `The reading may not be above a later one (${after.value})` }
  const allowance = loan.assetFinanceDeal?.usageAllowancePerYear
  if (actor.clientId && allowance) {
    // Measured from the lease's start reading, not the last one: repeated portal readings cannot ratchet the ceiling up.
    const start = await tx.assetMeterReading.findFirst({ where: { tenantId, loanId: input.loanId, unit }, orderBy: [{ readingDate: "asc" }, { value: "asc" }], select: { value: true, readingDate: true } })
    if (start) {
      const days = toDayNumber(input.readingDate) - toDayNumber(isoOfDbDate(start.readingDate))
      const ceiling = start.value + Math.ceil((allowance * PORTAL_PACE_LIMIT * (days + 31)) / 365)
      if (input.value > ceiling) return { kind: "refused", reason: "implausible_reading", error: `That is far above the contracted usage since the lease began (${start.value}); ask the lessor to record it` }
    }
  }
  if (input.evidenceDocumentId) {
    const dealId = loan.assetFinanceDeal?.id
    const document = dealId ? await tx.entityDocument.findFirst({ where: { id: input.evidenceDocumentId, tenantId, dealId, deletedAt: null }, select: { id: true } }) : null
    if (!document) return { kind: "refused", reason: "evidence", error: "The evidence must be a document filed on this lease" }
  }
  const reading = await tx.assetMeterReading.create({
    data: {
      tenantId, assetId: loan.assetId, loanId: input.loanId, readingDate: dbDate(input.readingDate), value: input.value, unit,
      source: actor.clientId ? "PORTAL" : "STAFF", evidenceDocumentId: input.evidenceDocumentId,
      recordedById: actor.userId ?? null, recordedByClientId: actor.clientId ?? null,
    },
    select: { id: true },
  })
  await logAuditStrict({
    tenantId, userId: actor.userId, action: AuditAction.METER_READING_RECORDED, entity: "AssetMeterReading", entityId: reading.id,
    newValue: { loanId: input.loanId, assetId: loan.assetId, readingDate: input.readingDate, value: input.value, unit, source: actor.clientId ? "PORTAL" : "STAFF", clientId: actor.clientId ?? null },
  }, tx)
  return { kind: "recorded", readingId: reading.id }
}
