/**
 * Meter readings of a leased asset (slice 3, C6), staff or portal, in the
 * caller's transaction. The unit is the lease's contracted unit (hours or km).
 * Readings are monotonic per asset and unit: a reading may not be below an
 * earlier-dated one nor above a later-dated one, and is immutable
 * (guardAssetMeterReading, migration 20261014100000); the check here is the
 * readable refusal. Audited.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, toDayNumber } from "./dates"
import type { SigningTx } from "./signing-prepare"
import { clientLeaseRefusal } from "./lease-portal-route"

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
    select: { assetId: true, status: true, startDate: true, assetFinanceDeal: { select: { id: true, usageUnit: true } } },
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
    tx.assetMeterReading.findFirst({ where: { tenantId, assetId: loan.assetId, unit, readingDate: { lte: dbDate(input.readingDate) } }, orderBy: [{ readingDate: "desc" }, { value: "desc" }], select: { value: true } }),
    tx.assetMeterReading.findFirst({ where: { tenantId, assetId: loan.assetId, unit, readingDate: { gt: dbDate(input.readingDate) } }, orderBy: [{ readingDate: "asc" }, { value: "asc" }], select: { value: true } }),
  ])
  if (before && input.value < before.value) return { kind: "refused", reason: "not_monotonic", error: `The reading may not be below an earlier one (${before.value})` }
  if (after && input.value > after.value) return { kind: "refused", reason: "not_monotonic", error: `The reading may not be above a later one (${after.value})` }
  if (input.evidenceDocumentId) {
    const document = await tx.entityDocument.findFirst({ where: { id: input.evidenceDocumentId, tenantId, dealId: loan.assetFinanceDeal?.id ?? "", deletedAt: null }, select: { id: true } })
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
