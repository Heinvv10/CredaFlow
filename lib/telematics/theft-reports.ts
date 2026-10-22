/**
 * Theft reports: the evidence the THEFT position purpose rests on
 * (docs/asset-finance/SLICE5-FOLLOWUPS.md part T). A collections officer or
 * above (view_asset_position) records the SAPS case number and the date the
 * theft was reported; the database checks the loan runs, the dates, the case
 * number's form, and sets the report valid for 30 days from the day it is
 * recorded (guardAssetTheftReport). A renewal is a new report naming the old
 * one, for the same case. Audited; never changed.
 */
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import type { AppRole } from "@/lib/auth-config"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, isoOfDbDate } from "@/lib/asset-finance/dates"
import { objectBody, refused, type TelematicsActor, type TelematicsResult } from "./result"

const CASE_NUMBER = /^CAS\s*([1-9]\d{0,5})\s*\/\s*(0?[1-9]|1[0-2])\s*\/\s*(\d{4})$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

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

export function parseTheftReport(body: unknown, today: string): { data: TheftReportInput } | { errors: Record<string, string> } {
  const record = objectBody(body) ?? {}
  const errors: Record<string, string> = {}
  const sapsCaseNumber = normaliseCaseNumber(record.sapsCaseNumber)
  if (!sapsCaseNumber) errors.sapsCaseNumber = "A SAPS case number reads CAS <number>/<month>/<year>, e.g. CAS 123/10/2026"
  else if (Number(sapsCaseNumber.split("/")[2]) > Number(today.slice(0, 4))) errors.sapsCaseNumber = "The case's year is not after this year"
  const reportedOn = typeof record.reportedOn === "string" && ISO_DATE.test(record.reportedOn) ? record.reportedOn : null
  if (!reportedOn) errors.reportedOn = "The date the theft was reported to SAPS (yyyy-mm-dd)"
  else if (reportedOn > today) errors.reportedOn = "The date the theft was reported is not in the future"
  const renews = record.renewsReportId
  if (renews !== undefined && renews !== null && typeof renews !== "string") errors.renewsReportId = "The report this renews"
  if (Object.keys(errors).length > 0 || !sapsCaseNumber || !reportedOn) return { errors }
  return { data: { sapsCaseNumber, reportedOn, renewsReportId: typeof renews === "string" && renews ? renews : null } }
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
  try {
    return await prisma.$transaction(async (tx) => {
      const report = await tx.assetTheftReport.create({
        data: {
          tenantId, loanId, assetId, sapsCaseNumber: data.sapsCaseNumber, reportedOn: dbDate(data.reportedOn),
          // The database sets the real validUntil (30 days from today); this placeholder is overwritten.
          validUntil: dbDate(data.reportedOn), renewsReportId: data.renewsReportId, recordedById: actor.userId,
        },
        select: { id: true, validUntil: true },
      })
      await logAuditStrict({
        tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_THEFT_REPORT_RECORDED,
        entity: "Loan", entityId: loanId,
        newValue: { reportId: report.id, sapsCaseNumber: data.sapsCaseNumber, reportedOn: data.reportedOn, renewsReportId: data.renewsReportId,
          validUntil: isoOfDbDate(report.validUntil) },
      }, tx)
      return { kind: "ok" as const, reportId: report.id, validUntil: isoOfDbDate(report.validUntil) }
    })
  } catch (error) {
    // guardAssetTheftReport: a loan not running, a date before the loan, a renewal of another case.
    if (isCheckViolation(error)) return refused(409, "The theft report was refused: the loan must be running, the dates within the loan, and a renewal of the same case")
    throw error
  }
}

export interface TheftReportView {
  id: string
  sapsCaseNumber: string
  reportedOn: string
  validUntil: string
  valid: boolean
  recordedBy: string
  recordedAt: string
  renewsReportId: string | null
}

/** The loan's theft reports, newest first, each with whether it is valid today. */
export async function theftReportsOf(tenantId: string, loanId: string): Promise<TheftReportView[]> {
  const today = sastCalendarDate(new Date())
  const rows = await prisma.assetTheftReport.findMany({
    where: { tenantId, loanId }, orderBy: { recordedAt: "desc" },
    select: { id: true, sapsCaseNumber: true, reportedOn: true, validUntil: true, recordedAt: true, renewsReportId: true,
      recordedBy: { select: { name: true, email: true } } },
  })
  return rows.map((r) => ({
    id: r.id, sapsCaseNumber: r.sapsCaseNumber, reportedOn: isoOfDbDate(r.reportedOn), validUntil: isoOfDbDate(r.validUntil),
    valid: isoOfDbDate(r.validUntil) >= today, recordedBy: r.recordedBy.name ?? r.recordedBy.email, recordedAt: r.recordedAt.toISOString(),
    renewsReportId: r.renewsReportId,
  }))
}
