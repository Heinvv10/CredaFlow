/**
 * Where a tracker's meter reading goes (docs/asset-finance/SLICE5.md part B).
 * A real provider's device whose meter staff have not verified against the
 * asset's own feeds nothing (METER_UNVERIFIED): an offset meter would bill the
 * lessee unattended. Otherwise a running operating or full-maintenance lease
 * of the asset, with usage terms in the meter's unit, gets a TELEMATICS
 * reading through recordMeterReading, one a day (a live held reading counts:
 * a rejected one leaves room for a corrected reading); a reading the monotonic
 * or pace rule refuses is held for staff. The asset row is locked before the
 * monotonic check, so a staff reading written meanwhile is seen, not raced. Anything else
 * stays a device reading only (the event's meterOutcome says why).
 * guardTelematicsMeterReading repeats every rule in the database.
 */
import type { TelematicsHeldReason, TelematicsMeterOutcome, UsageUnit } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate } from "@/lib/asset-finance/dates"
import { leaseTermEnd } from "@/lib/asset-finance/lease-term-end"
import { recordMeterReading } from "@/lib/asset-finance/meter-readings"
import type { SigningTx } from "@/lib/asset-finance/signing-prepare"

/** The lease types whose contracted usage a meter feeds (recordMeterReading's set). */
export const USAGE_LEASES = ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] as const

export interface MeterDevice {
  tenantId: string
  assetId: string
  /** The event's: a simulated device's meter is the simulator's own. */
  simulated: boolean
  meterVerifiedAt?: Date | null
}

/** The lease running on the asset on `day`: ACTIVE or DEFAULTED, started on or before it (the latest such). */
async function loanOn(tx: SigningTx, device: MeterDevice, day: string) {
  const loans = await tx.loan.findMany({
    where: { tenantId: device.tenantId, assetId: device.assetId, status: { in: ["ACTIVE", "DEFAULTED"] } },
    orderBy: { startDate: "desc" },
    select: { id: true, startDate: true, contractType: true, assetFinanceDeal: { select: { usageUnit: true } } },
  })
  return loans.find((loan) => sastCalendarDate(loan.startDate) <= day) ?? null
}

async function leaseEnded(tx: SigningTx, tenantId: string, loanId: string, day: string): Promise<boolean> {
  const termEnd = await leaseTermEnd(tx, tenantId, loanId)
  if (termEnd === null || day >= termEnd) return true
  // Only an end that stops the asset's use before the term ends: a total loss, an early termination.
  const [endOfTerm, accepted] = await Promise.all([
    tx.leaseEndOfTerm.count({ where: { tenantId, loanId, OR: [{ outcome: "TOTAL_LOSS" }, { origin: "EARLY_TERMINATION" }] } }),
    tx.leaseTerminationQuote.count({ where: { tenantId, loanId, status: "ACCEPTED" } }),
  ])
  return endOfTerm > 0 || accepted > 0
}

export async function routeMeterReading(
  tx: SigningTx, device: MeterDevice, eventId: string, meter: { value: number; unit: UsageUnit }, occurredAt: Date, today: string,
): Promise<TelematicsMeterOutcome> {
  const { tenantId, assetId } = device
  if (!device.simulated && !device.meterVerifiedAt) return "METER_UNVERIFIED"
  const readingDate = sastCalendarDate(occurredAt)
  const loan = await loanOn(tx, device, readingDate)
  if (!loan) return "LEASE_NOT_RUNNING"
  if (!(USAGE_LEASES as readonly string[]).includes(loan.contractType ?? "")) return "NOT_LEASE"
  const unit = loan.assetFinanceDeal?.usageUnit
  if (!unit || unit !== meter.unit) return "NO_USAGE_TERMS"
  if (await leaseEnded(tx, tenantId, loan.id, readingDate)) return "LEASE_NOT_RUNNING"
  const [written, held] = await Promise.all([
    tx.assetMeterReading.count({ where: { tenantId, loanId: loan.id, readingDate: dbDate(readingDate), source: "TELEMATICS" } }),
    tx.telematicsHeldReading.count({ where: { tenantId, loanId: loan.id, readingDate: dbDate(readingDate), status: { in: ["HELD", "ACCEPTED"] } } }),
  ])
  if (written + held > 0) return "SAME_DAY"

  // The asset's meter is one sequence: lock it as the meter trigger does, before reading its neighbours.
  await tx.$queryRaw`SELECT 1 FROM "FinancedAsset" WHERE "id" = ${assetId} AND "tenantId" = ${tenantId} FOR UPDATE`
  const result = await recordMeterReading(tx, { tenantId, telematics: { eventId } }, { loanId: loan.id, readingDate, value: meter.value, evidenceDocumentId: null, today })
  if (result.kind === "recorded") return "RECORDED"
  if (result.kind === "refused" && (result.reason === "not_monotonic" || result.reason === "implausible_reading")) {
    const reason: TelematicsHeldReason = result.reason === "implausible_reading" ? "IMPLAUSIBLE" : result.bound === "later" ? "ABOVE_LATER" : "LOWER"
    const held = await tx.telematicsHeldReading.create({
      data: { tenantId, eventId, loanId: loan.id, assetId, readingDate: dbDate(readingDate), value: meter.value, unit, reason },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId, action: AuditAction.TELEMATICS_READING_HELD, entity: "TelematicsHeldReading", entityId: held.id,
      newValue: { eventId, loanId: loan.id, assetId, readingDate, value: meter.value, unit, reason, actor: { type: "system", source: "telematics", eventId } },
    }, tx)
    return "HELD"
  }
  if (result.kind === "refused" && (result.reason === "lease_closed" || result.reason === "reading_date")) return "LEASE_NOT_RUNNING"
  throw new Error(`Unexpected meter reading result for telematics event ${eventId}: ${result.kind === "refused" ? result.reason : result.kind}`)
}
