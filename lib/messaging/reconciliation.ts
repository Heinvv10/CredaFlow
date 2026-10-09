import type { MessageDispatchState, Prisma } from "@prisma/client"

export const MESSAGE_RECONCILIATION_ERROR_CLASS =
  "RETRY_DISPATCH_CLAIMED_MANUAL_RECONCILIATION"

const HELD_DISPATCH_STATES: MessageDispatchState[] = ["AMBIGUOUS", "ACCEPTED", "SIMULATED"]

export type MessageReconciliationOutcome = "SENT" | "SIMULATED" | "NOT_SENT"

export function allowedMessageReconciliationOutcomes(
  dispatchState: string | null | undefined,
): readonly MessageReconciliationOutcome[] {
  if (dispatchState === "ACCEPTED") return ["SENT"]
  if (dispatchState === "SIMULATED") return ["SIMULATED"]
  if (dispatchState === "AMBIGUOUS" || dispatchState === "DISPATCHING") {
    return ["SENT", "SIMULATED", "NOT_SENT"]
  }
  return []
}

export function messageReconciliationCandidateWhere(now = new Date()): Prisma.MessageWhereInput {
  return {
    OR: [
      {
        dispatchState: { in: HELD_DISPATCH_STATES },
      },
      {
        dispatchState: "DISPATCHING" as const,
        dispatchLeaseExpiresAt: { lte: now },
      },
    ],
  }
}

export function requiresMessageReconciliation(input: {
  status: string
  dispatchState?: string | null
  dispatchLeaseExpiresAt?: Date | string | null
}, now = new Date()): boolean {
  if (input.status !== "QUEUED") return false
  if (["AMBIGUOUS", "ACCEPTED", "SIMULATED"].includes(input.dispatchState ?? "")) {
    return true
  }
  if (input.dispatchState !== "DISPATCHING" || !input.dispatchLeaseExpiresAt) return false
  const leaseExpiresAt = input.dispatchLeaseExpiresAt instanceof Date
    ? input.dispatchLeaseExpiresAt
    : new Date(input.dispatchLeaseExpiresAt)
  return Number.isFinite(leaseExpiresAt.getTime()) && leaseExpiresAt.getTime() <= now.getTime()
}

export function messagePresentationStatus(input: {
  status: string
  dispatchState?: string | null
  dispatchLeaseExpiresAt?: Date | string | null
}, now = new Date()): string {
  return requiresMessageReconciliation(input, now)
    ? "RECONCILIATION_REQUIRED"
    : input.status
}
