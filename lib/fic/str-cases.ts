import { randomBytes } from "node:crypto"
import type { SuspiciousReportKind, SuspiciousReportStatus } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { canDo, type UserRole } from "@/lib/permissions"

/**
 * Suspicious / unusual transaction register. The rules here are pinned to the
 * DB CHECK SuspiciousReportCase_outcome_complete and the trigger
 * guardSuspiciousReportCase (migration 20261014150000_w4_screening_fic).
 *
 * Tipping off: telling the client, or anyone without a need to know, that a
 * report was or may be made is an offence under the FIC Act. Hence: the
 * register is restricted to `manage_fic_compliance`, every read of it is
 * logged, nothing about a case appears on client- or loan-facing screens, and
 * audit rows carry the case id and status only.
 */

export { CLOSE_NOTE_MIN_LENGTH, GROUNDS_MAX_LENGTH, GROUNDS_MIN_LENGTH, TIPPING_OFF_WARNING } from "./str-copy"
import { CLOSE_NOTE_MIN_LENGTH } from "./str-copy"

export const STR_KINDS: readonly SuspiciousReportKind[] = ["SUSPICIOUS_TRANSACTION", "UNUSUAL_TRANSACTION", "SUSPICIOUS_ACTIVITY"]

export function canAccessStrRegister(role: UserRole | string): boolean {
  return canDo(role, "manage_fic_compliance")
}

export function canRaiseStr(role: UserRole | string): boolean {
  return canDo(role, "raise_suspicious_report")
}

export function isStrKind(value: unknown): value is SuspiciousReportKind {
  return typeof value === "string" && (STR_KINDS as readonly string[]).includes(value)
}

const TRANSITIONS: Record<SuspiciousReportStatus, readonly SuspiciousReportStatus[]> = {
  OPEN: ["UNDER_REVIEW", "REPORTED", "CLOSED_NO_REPORT"],
  UNDER_REVIEW: ["REPORTED", "CLOSED_NO_REPORT"],
  REPORTED: [],
  CLOSED_NO_REPORT: [],
}

export function canTransitionStr(from: SuspiciousReportStatus, to: SuspiciousReportStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export type StrUpdate =
  | { status: "UNDER_REVIEW" }
  | { status: "REPORTED"; fiuReference: string; reportedAt: Date; assessmentNote: string | null }
  | { status: "CLOSED_NO_REPORT"; assessmentNote: string }

/** Validates a PATCH body into one of the allowed updates. */
export function parseStrUpdate(body: Record<string, unknown> | null): { ok: true; value: StrUpdate } | { ok: false; error: string } {
  const status = body?.status
  const note = typeof body?.assessmentNote === "string" ? body.assessmentNote.trim() : ""
  if (status === "UNDER_REVIEW") return { ok: true, value: { status } }
  if (status === "REPORTED") {
    const fiuReference = typeof body?.fiuReference === "string" ? body.fiuReference.trim() : ""
    const reportedAt = typeof body?.reportedAt === "string" ? new Date(body.reportedAt) : null
    if (!fiuReference || fiuReference.length > 100) return { ok: false, error: "Give the FIC (goAML) reference of the filed report." }
    if (!reportedAt || Number.isNaN(reportedAt.getTime()) || reportedAt.getTime() > Date.now()) {
      return { ok: false, error: "Give the date the report was filed (not in the future)." }
    }
    return { ok: true, value: { status, fiuReference, reportedAt, assessmentNote: note || null } }
  }
  if (status === "CLOSED_NO_REPORT") {
    if ([...note].length < CLOSE_NOTE_MIN_LENGTH) {
      return { ok: false, error: `Say why no report is made (at least ${CLOSE_NOTE_MIN_LENGTH} characters).` }
    }
    return { ok: true, value: { status, assessmentNote: note } }
  }
  return { ok: false, error: "status must be UNDER_REVIEW, REPORTED or CLOSED_NO_REPORT." }
}

export function generateStrReference(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "")
  return `STR-${day}-${randomBytes(3).toString("hex").toUpperCase()}`
}

export type StrAccessAction = "VIEW_REGISTER" | "VIEW_CASE" | "UPDATE_CASE" | "EXPORT"

/** Appends to the STR access log (append-only in the database). */
export async function logStrAccess(
  db: Pick<typeof prisma, "suspiciousReportAccess">,
  entry: { tenantId: string; userId: string; action: StrAccessAction; caseId?: string | null },
): Promise<void> {
  await db.suspiciousReportAccess.create({
    data: { tenantId: entry.tenantId, userId: entry.userId, action: entry.action, caseId: entry.caseId ?? null },
  })
}
