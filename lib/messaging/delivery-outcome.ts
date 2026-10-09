import type { MsgStatus } from "@prisma/client"

export type MessageDeliveryOutcome = "sent" | "simulated" | "pending" | "not_sent"

/** Keep the key only while a provider outcome remains unresolved. */
export function mayReleaseMessageOperationId(
  outcome: Exclude<MessageDeliveryOutcome, "not_sent"> | undefined,
  reconciliationRequired = false,
): boolean {
  return (outcome === "sent" || outcome === "simulated") && !reconciliationRequired
}

export function messageOperationIdAfterOutcome(
  currentOperationId: string | null,
  outcome: Exclude<MessageDeliveryOutcome, "not_sent"> | undefined,
  reconciliationRequired = false,
): string | null {
  return mayReleaseMessageOperationId(outcome, reconciliationRequired)
    ? null
    : currentOperationId
}

export function messageOperationIdAfterChannelSelection(
  currentOperationId: string | null,
  currentChannel: string | null,
  nextChannel: string,
): string | null {
  return currentChannel === nextChannel ? currentOperationId : null
}

/**
 * Project persisted transport state into the four outcomes staff workflows
 * need. A durable Message row is not proof that anything was sent.
 */
export function messageDeliveryOutcome(status: MsgStatus): MessageDeliveryOutcome {
  switch (status) {
    case "SENT":
    case "DELIVERED":
    case "READ":
      return "sent"
    case "SIMULATED":
      return "simulated"
    case "QUEUED":
    case "RETRYING":
      return "pending"
    case "FAILED":
    case "FAILED_PERMANENT":
    case "SUPPRESSED_BY_CONSENT":
    case "EXPIRED":
    case "BOUNCED":
      return "not_sent"
    default: {
      const exhaustive: never = status
      throw new Error(`Unhandled message status: ${exhaustive}`)
    }
  }
}
