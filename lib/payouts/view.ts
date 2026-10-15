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
}

export interface PayoutView {
  loanId: string
  loanStatus: string
  /** Newest attempt first. */
  attempts: PayoutAttemptView[]
  reversal: { id: string; status: "REQUESTED" | "APPROVED" | "REJECTED"; reason: string; requestedAt: string; decisionNote: string | null } | null
}

/** A loan's payout attempts and reversal as the staff page shows them: account numbers masked to the last four digits. */
export async function loadPayoutView(tenantId: string, loanId: string, loanStatus: string): Promise<PayoutView | null> {
  const [attempts, reversal] = await Promise.all([
    prisma.disbursementPayout.findMany({ where: { tenantId, loanId }, orderBy: { attempt: "desc" } }),
    prisma.disbursementReversal.findFirst({ where: { tenantId, loanId }, orderBy: { requestedAt: "desc" } }),
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
    })),
    reversal: reversal
      ? { id: reversal.id, status: reversal.status, reason: reversal.reason, requestedAt: reversal.requestedAt.toISOString(), decisionNote: reversal.decisionNote }
      : null,
  }
}
