/**
 * How bad an approval exception was when it was answered, and whether it has
 * got worse since (security review of #151). The approval stores one
 * RecordedException per exception (AssetFinanceDeal.approvalExceptions);
 * payout and booking refuse an exception that is new OR worse
 * (./deal-credit-gate.ts):
 *
 *   ARREARS  worse when the loan's status moved up the ladder
 *            (ACTIVE/RESTRUCTURED → DEFAULTED → PENDING_WRITE_OFF →
 *            WRITTEN_OFF) or its days in arrears moved into a later band
 *            (1–29, 30–59, 60–89, 90+). A larger arrears amount alone is
 *            NOT worse (policy, follow-up to #151): the amount overdue rises
 *            at every due date the loan misses between approval and booking,
 *            so it would block almost every approved override. It is
 *            recorded instead: arrearsGrowth, written to the payout and
 *            booking audit rows.
 *   BUREAU   worse when the person's latest outcome is not the one answered.
 *
 * The approver's reason binds to exceptionsFingerprint: the keys with their
 * status and DPD band, the same measure of severity; the amount is left out
 * because it moves with every missed due date.
 * Pure and client-safe apart from the hash.
 */
import { createHash } from "node:crypto"
import type { LoanStatus } from "@prisma/client"

export type RecordedException =
  | { key: string; kind: "ARREARS"; status: LoanStatus; daysInArrears: number; arrearsCents: number }
  | { key: string; kind: "BUREAU"; outcome: string }

const STATUS_RANK: Partial<Record<LoanStatus, number>> = { ACTIVE: 0, RESTRUCTURED: 0, DEFAULTED: 1, PENDING_WRITE_OFF: 2, WRITTEN_OFF: 3 }

/** 0 current, 1: 1–29, 2: 30–59, 3: 60–89, 4: 90+ days in arrears. */
export function dpdBand(days: number): number {
  if (days <= 0) return 0
  if (days < 30) return 1
  if (days < 60) return 2
  if (days < 90) return 3
  return 4
}

const severityTag = (e: RecordedException) =>
  e.kind === "ARREARS" ? `${e.key}|${e.status}|${dpdBand(e.daysInArrears)}` : `${e.key}|${e.outcome}`

export function exceptionsFingerprint(exceptions: RecordedException[]): string {
  return createHash("sha256").update(JSON.stringify(exceptions.map(severityTag).sort())).digest("hex")
}

/** Why `current` is worse than what the approval answered; null when it is not. */
export function worsenedSince(approved: RecordedException, current: RecordedException): string | null {
  if (approved.kind === "BUREAU" || current.kind === "BUREAU") {
    return approved.kind === "BUREAU" && current.kind === "BUREAU" && approved.outcome === current.outcome
      ? null : "its bureau outcome changed"
  }
  if ((STATUS_RANK[current.status] ?? 0) > (STATUS_RANK[approved.status] ?? 0)) return `it moved from ${approved.status} to ${current.status}`
  if (dpdBand(current.daysInArrears) > dpdBand(approved.daysInArrears)) {
    return `its days in arrears moved from ${approved.daysInArrears} to ${current.daysInArrears}`
  }
  return null
}

export interface ArrearsGrowth {
  key: string
  approvedArrearsCents: number
  currentArrearsCents: number
  approvedDaysInArrears: number
  currentDaysInArrears: number
}

/** The answered arrears exception's amount growth since approval (not a refusal: recorded in the audit); null if none. */
export function arrearsGrowth(approved: RecordedException, current: RecordedException): ArrearsGrowth | null {
  if (approved.kind !== "ARREARS" || current.kind !== "ARREARS" || current.arrearsCents <= approved.arrearsCents) return null
  return {
    key: current.key,
    approvedArrearsCents: approved.arrearsCents, currentArrearsCents: current.arrearsCents,
    approvedDaysInArrears: approved.daysInArrears, currentDaysInArrears: current.daysInArrears,
  }
}

/** The stored approvalExceptions as recorded exceptions; anything else is ignored (none are written outside decideDeal). */
export function recordedExceptions(value: unknown): RecordedException[] {
  if (!Array.isArray(value)) return []
  return value.filter((e): e is RecordedException =>
    typeof e === "object" && e !== null && typeof (e as { key?: unknown }).key === "string"
    && ((e as { kind?: unknown }).kind === "ARREARS" || (e as { kind?: unknown }).kind === "BUREAU"))
}
