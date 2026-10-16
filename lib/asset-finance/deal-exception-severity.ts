/**
 * How bad an approval exception was when it was answered, and whether it has
 * got worse since (security review of #151). The approval stores one
 * RecordedException per exception (AssetFinanceDeal.approvalExceptions);
 * payout and booking refuse an exception that is new OR worse
 * (./deal-credit-gate.ts):
 *
 *   ARREARS  worse when the loan's status moved up the ladder
 *            (ACTIVE/RESTRUCTURED → DEFAULTED → PENDING_WRITE_OFF →
 *            WRITTEN_OFF), its days in arrears moved into a later band
 *            (1–29, 30–59, 60–89, 90+), or its arrears amount grew.
 *   BUREAU   worse when the person's latest outcome is not the one answered.
 *
 * The approver's reason binds to exceptionsFingerprint: the keys with their
 * status and DPD band (not the exact amount, which charges move nightly).
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
  if (current.arrearsCents > approved.arrearsCents) return "its arrears amount grew"
  return null
}

/** The stored approvalExceptions as recorded exceptions; anything else is ignored (none are written outside decideDeal). */
export function recordedExceptions(value: unknown): RecordedException[] {
  if (!Array.isArray(value)) return []
  return value.filter((e): e is RecordedException =>
    typeof e === "object" && e !== null && typeof (e as { key?: unknown }).key === "string"
    && ((e as { kind?: unknown }).kind === "ARREARS" || (e as { kind?: unknown }).kind === "BUREAU"))
}
