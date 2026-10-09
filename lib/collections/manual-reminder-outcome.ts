import type { KnownDispatchEvidence } from "@/lib/messaging/send"

export type ReminderChannel = "SMS" | "WhatsApp"
export type ReminderChannelOutcome =
  | "sent"
  | "simulated"
  | "pending"
  | "reconciliation_required"
  | "blocked"
  | "failed"

export type ReminderDelivery = {
  channel: ReminderChannel
  outcome: ReminderChannelOutcome
  messageId?: string
  detail?: string
  knownDispatchEvidence?: KnownDispatchEvidence
}

export function reminderDeliverySummary(deliveries: ReminderDelivery[]): string {
  return deliveries.map((delivery) => {
    const state = delivery.outcome === "simulated"
      ? "simulated (not sent)"
      : delivery.outcome === "blocked"
        ? "blocked (not sent)"
        : delivery.outcome === "failed"
          ? "failed (not sent)"
          : delivery.outcome === "pending"
            ? "pending — do not resend"
            : delivery.outcome === "reconciliation_required"
              ? "reconciliation required — do not resend"
              : delivery.outcome
    const id = delivery.messageId ? ` [${delivery.messageId}]` : ""
    const detail = delivery.detail ? ` — ${delivery.detail}` : ""
    return `${delivery.channel}: ${state}${id}${detail}`
  }).join("; ")
}
