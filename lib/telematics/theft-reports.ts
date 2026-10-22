/**
 * Theft reports: the evidence the THEFT position purpose rests on
 * (docs/asset-finance/SLICE5-FOLLOWUPS.md part T). A collections officer or
 * above (view_asset_position) records the SAPS case number and the date the
 * theft was reported (no more than REPORT_MAX_AGE_DAYS before today); the
 * database checks the loan runs, the dates, the case number's form, and sets
 * the report valid for 30 days from the day it is recorded
 * (guardAssetTheftReport). A second person confirms it before THEFT holds;
 * it can be ended once, with a reason (the asset found). A renewal is a new
 * report naming the old one, same case and date. Audited; never deleted.
 */
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import type { AppRole } from "@/lib/auth-config"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "@/lib/asset-finance/dates"
import { objectBody, refused, type TelematicsActor, type TelematicsResult } from "./result"

const CASE_NUMBER = /^CAS\s*([1-9]\d{0,5})\s*\/\s*(0?[1-9]|1[0-2])\s*\/\s*(\d{4})$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** How long after reporting the theft to SAPS a report may be recorded (the database holds it too). */
export const REPORT_MAX_AGE_DAYS = 14
export const END_REASON_MIN = 10
export const END_REASON_MAX = 500

/** "CAS 123/10/2026" from what staff typed ("cas123/10/2026" too), or null when it is not a SAPS case number. */
export function normaliseCaseNumber(value: unknown): string | null {
  const match = typeof value === "string" ? CASE_NUMBER.exec(value.trim()) : null
  return match ? `CAS ${match[1]}/${Number(match[2])}/${match[3]}` : null
}

export interface TheftReportInput {
  sapsCaseNumber: string
  reportedOn: string
  renewsReportId: string | null
}

/** A renewal's date is the renewed report's (set by recordTheftReport): only a first report's date is read and bounded here. */
export function parseTheftReport(body: unknown, today: string): { data: TheftReportInput } | { errors: Record<string, string> } {
  const record = objectBody(body) ?? {}
  const errors: Record<string, string> = {}
  const renews = record.renewsReportId
  if (renews !== undefined && renews !== null && typeof renews !== "string") errors.renewsReportId = "The report this renews"
  const renewing = typeof renews === "string" && renews !== ""
  const sapsCaseNumber = normaliseCaseNumber(record.sapsCaseNumber)
  if (!sapsCaseNumber) errors.sapsCaseNumber = "A SAPS case number reads CAS <number>/<month>/<year>, e.g. CAS 123/10/2026"
  else if (Number(sapsCaseNumber.split("/")[2]) > Number(today.slice(0, 4))) errors.sapsCaseNumber = "The case's year is not after this year"
  const reportedOn = renewing ? today : typeof record.reportedOn === "string" && ISO_DATE.test(record.reportedOn) ? record.reportedOn : null
  if (!reportedOn) errors.reportedOn = "The date the theft was reported to SAPS (yyyy-mm-dd)"
  else if (reportedOn > today) errors.reportedOn = "The date the theft was reported is not in the future"
  else if (!renewing && reportedOn < fromDayNumber(toDayNumber(today) - REPORT_MAX_AGE_DAYS)) {
    errors.reportedOn = `A theft is recorded within ${REPORT_MAX_AGE_DAYS} days of its report to SAPS`
  }
  if (Object.keys(errors).length > 0 || !sapsCaseNumber || !reportedOn) return { errors }
  return { data: { sapsCaseNumber, reportedOn, renewsReportId: renewing ? renews : null } }
}

export async function recordTheftReport(
  actor: TelematicsActor & { role: string }, loanId: string, body: unknown,
): Promise<TelematicsResult<{ reportId: string; validUntil: string }>> {
  const { tenantId } = actor
  if (!canDo(actor.role as AppRole, "view_asset_position")) return refused(403, "Recording a theft report needs the view_asset_position permission")
  const parsed = parseTheftReport(body, sastCalendarDate(new Date()))
  if ("errors" in parsed) return refused(400, "Invalid theft report", parsed.errors)
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId }, select: { id: true, assetId: true } })
  if (!loan?.assetId) return refused(404, "Loan not found")
  const assetId = loan.assetId
  const { data } = parsed
  // A renewal keeps the renewed report's date (the database refuses any other).
  const renewed = data.renewsReportId
    ? await prisma.assetTheftReport.findFirst({ where: { id: data.renewsReportId, tenantId, loanId }, select: { reportedOn: true, sapsCaseNumber: true } })
    : null
  if (data.renewsReportId && (!renewed || renewed.sapsCaseNumber !== data.sapsCaseNumber)) {
    return refused(409, "A renewal is of a report on this loan, for the same SAPS case")
  }
  const reportedOn = renewed ? isoOfDbDate(renewed.reportedOn) : data.reportedOn
  try {
    return await prisma.$transaction(async (tx) => {
      const report = await tx.assetTheftReport.create({
        data: {
          tenantId, loanId, assetId, sapsCaseNumber: data.sapsCaseNumber, reportedOn: dbDate(reportedOn),
          // The database sets the real validUntil (30 days from today); this placeholder is overwritten.
          validUntil: dbDate(reportedOn), renewsReportId: data.renewsReportId, recordedById: actor.userId,
        },
        select: { id: true, validUntil: true },
      })
      await logAuditStrict({
        tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_THEFT_REPORT_RECORDED,
        entity: "Loan", entityId: loanId,
        newValue: { reportId: report.id, sapsCaseNumber: data.sapsCaseNumber, reportedOn, renewsReportId: data.renewsReportId,
          validUntil: isoOfDbDate(report.validUntil) },
      }, tx)
      return { kind: "ok" as const, reportId: report.id, validUntil: isoOfDbDate(report.validUntil) }
    })
  } catch (error) {
    // guardAssetTheftReport: a loan not running, a date before the loan, a renewal of another case.
    if (isCheckViolation(error)) {
      return refused(409, `The theft report was refused: the loan must be running, the theft reported within the loan and in the last ${REPORT_MAX_AGE_DAYS} days, and a renewal of the same case (at most twice: then open a recovery or a legal matter)`)
    }
    throw error
  }
}

export interface TheftReportView {
  id: string
  sapsCaseNumber: string
  reportedOn: string
  validUntil: string
  /** Confirmed, not ended and within its 30 days: THEFT holds. */
  valid: boolean
  recordedById: string
  recordedBy: string
  recordedAt: string
  confirmedBy: string | null
  ended: { by: string; at: string; reason: string } | null
  renewsReportId: string | null
}

/** The loan's theft reports, newest first, each with whether it is valid today. */
export async function theftReportsOf(tenantId: string, loanId: string): Promise<TheftReportView[]> {
  const today = sastCalendarDate(new Date())
  const rows = await prisma.assetTheftReport.findMany({
    where: { tenantId, loanId }, orderBy: { recordedAt: "desc" },
    select: { id: true, sapsCaseNumber: true, reportedOn: true, validUntil: true, recordedAt: true, renewsReportId: true, recordedById: true,
      confirmedAt: true, endedAt: true, endReason: true,
      recordedBy: { select: { name: true, email: true } }, confirmedBy: { select: { name: true, email: true } }, endedBy: { select: { name: true, email: true } } },
  })
  const who = (u: { name: string | null; email: string } | null) => (u ? u.name ?? u.email : null)
  return rows.map((r) => ({
    id: r.id, sapsCaseNumber: r.sapsCaseNumber, reportedOn: isoOfDbDate(r.reportedOn), validUntil: isoOfDbDate(r.validUntil),
    valid: r.confirmedAt !== null && r.endedAt === null && isoOfDbDate(r.validUntil) >= today,
    recordedById: r.recordedById, recordedBy: who(r.recordedBy) ?? "", recordedAt: r.recordedAt.toISOString(),
    confirmedBy: r.confirmedAt ? who(r.confirmedBy) : null,
    ended: r.endedAt && r.endReason ? { by: who(r.endedBy) ?? "", at: r.endedAt.toISOString(), reason: r.endReason } : null,
    renewsReportId: r.renewsReportId,
  }))
}

/**
 * A second person confirms a recorded report (view_asset_position, not the recorder; the database refuses the
 * recorder too). Only then does THEFT hold. Audited.
 */
export async function confirmTheftReport(actor: TelematicsActor & { role: string }, loanId: string, reportId: string): Promise<TelematicsResult> {
  const { tenantId } = actor
  if (!canDo(actor.role as AppRole, "view_asset_position")) return refused(403, "Confirming a theft report needs the view_asset_position permission")
  const report = await prisma.assetTheftReport.findFirst({ where: { id: reportId, tenantId, loanId }, select: { id: true, recordedById: true, confirmedAt: true, endedAt: true } })
  if (!report) return refused(404, "Theft report not found")
  if (report.recordedById === actor.userId) return refused(409, "A second person confirms a theft report: not the one who recorded it")
  if (report.confirmedAt || report.endedAt) return refused(409, "This theft report is already confirmed or ended")
  try {
    return await prisma.$transaction(async (tx) => {
      const done = await tx.assetTheftReport.updateMany({ where: { id: reportId, tenantId, confirmedAt: null, endedAt: null }, data: { confirmedById: actor.userId, confirmedAt: new Date() } })
      if (done.count !== 1) return refused(409, "This theft report is already confirmed or ended")
      await logAuditStrict({ tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_THEFT_REPORT_CONFIRMED, entity: "Loan", entityId: loanId, newValue: { reportId } }, tx)
      return { kind: "ok" as const }
    })
  } catch (error) {
    if (isCheckViolation(error)) return refused(409, "The theft report cannot be confirmed: by a second person, on a running loan")
    throw error
  }
}

/** Ends a report early (the asset found), once, with a reason; THEFT stops holding at once. Audited. */
export async function endTheftReport(actor: TelematicsActor & { role: string }, loanId: string, reportId: string, body: unknown): Promise<TelematicsResult> {
  const { tenantId } = actor
  if (!canDo(actor.role as AppRole, "view_asset_position")) return refused(403, "Ending a theft report needs the view_asset_position permission")
  const raw = objectBody(body)?.reason
  const reason = typeof raw === "string" ? raw.trim() : ""
  if (reason.length < END_REASON_MIN || reason.length > END_REASON_MAX) {
    return refused(400, "Say why the report ends", { reason: `${END_REASON_MIN} to ${END_REASON_MAX} characters` })
  }
  return prisma.$transaction(async (tx) => {
    const done = await tx.assetTheftReport.updateMany({ where: { id: reportId, tenantId, loanId, endedAt: null }, data: { endedById: actor.userId, endedAt: new Date(), endReason: reason } })
    if (done.count !== 1) return refused(404, "No open theft report with that id on this loan")
    await logAuditStrict({ tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_THEFT_REPORT_ENDED, entity: "Loan", entityId: loanId, newValue: { reportId, reason } }, tx)
    return { kind: "ok" as const }
  })
}
