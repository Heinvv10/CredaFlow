import { prisma } from "@/lib/prisma"
import type { PayoutStatus } from "./state"

export interface PayoutAttemptView {
  id: string
  attempt: number
  status: PayoutStatus
  provider: string
  amountCents: number
  bankName: string
  accountTail: string
  simulated: boolean
  providerReference: string | null
  failureReason: string | null
  submittedAt: string | null
  resolvedAt: string | null
  resolutionNote: string | null
  /** A provider reported money moving after this attempt was over, not yet resolved. */
  conflict: { state: string; detail: string | null; at: string } | null
}

/** Money paid out after the disbursement was reversed (lib/payouts/recovery.ts). */
export interface RecoveryView {
  id: string
  attempt: number
  status: "OPEN" | "ESCALATED" | "RECOVERED"
  amountCents: number
  paidAt: string
  openNote: string
  escalationNote: string | null
  recoveredAt: string | null
}

export interface PayoutView {
  loanId: string
  loanStatus: string
  /** Newest attempt first. */
  attempts: PayoutAttemptView[]
  reversal: {
    id: string; status: "REQUESTED" | "APPROVED" | "REJECTED"; reason: string; requestedAt: string; decisionNote: string | null
    /** The by-hand debit-order cancellation an approved reversal leaves, once acknowledged. */
    debitOrderCancelAckAt: string | null
  } | null
  recoveries: RecoveryView[]
  /** The credit bureau already knows the account: a reversal needs a cancellation (V) record by hand. */
  bureauRegistered: boolean
}

/** A loan's payout attempts and reversal as the staff page shows them: account numbers masked to the last four digits. */
export async function loadPayoutView(tenantId: string, loanId: string, loanStatus: string): Promise<PayoutView | null> {
  const [attempts, reversal, bureauLines, recoveries] = await Promise.all([
    prisma.disbursementPayout.findMany({ where: { tenantId, loanId }, orderBy: { attempt: "desc" } }),
    prisma.disbursementReversal.findFirst({ where: { tenantId, loanId }, orderBy: { requestedAt: "desc" } }),
    prisma.bureauSubmissionRecord.count({ where: { tenantId, loanId, mode: "LIVE", heldReason: null } }),
    prisma.payoutRecoveryCase.findMany({ where: { tenantId, loanId }, orderBy: { createdAt: "asc" }, include: { payout: { select: { attempt: true } } } }),
  ])
  if (attempts.length === 0) return null
  return {
    loanId,
    loanStatus,
    attempts: attempts.map((p) => ({
      id: p.id,
      attempt: p.attempt,
      status: p.status as PayoutStatus,
      provider: p.provider,
      amountCents: p.amountCents,
      bankName: p.bankName,
      accountTail: p.accountNumber.slice(-4),
      simulated: p.simulated,
      providerReference: p.providerReference,
      failureReason: p.failureReason,
      submittedAt: p.submittedAt?.toISOString() ?? null,
      resolvedAt: p.resolvedAt?.toISOString() ?? null,
      resolutionNote: p.resolutionNote,
      conflict: p.providerConflictAt && !p.conflictResolvedAt
        ? { state: p.providerConflictState ?? "", detail: p.providerConflictDetail, at: p.providerConflictAt.toISOString() }
        : null,
    })),
    bureauRegistered: bureauLines > 0,
    reversal: reversal
      ? {
        id: reversal.id, status: reversal.status, reason: reversal.reason, requestedAt: reversal.requestedAt.toISOString(), decisionNote: reversal.decisionNote,
        debitOrderCancelAckAt: reversal.debitOrderCancelAckAt?.toISOString() ?? null,
      }
      : null,
    recoveries: recoveries.map((r) => ({
      id: r.id, attempt: r.payout.attempt, status: r.status, amountCents: r.amountCents, paidAt: r.paidAt.toISOString(),
      openNote: r.openNote, escalationNote: r.escalationNote, recoveredAt: r.recoveredAt?.toISOString() ?? null,
    })),
  }
}
