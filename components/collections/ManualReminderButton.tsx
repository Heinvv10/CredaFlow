"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "@/lib/toast"

interface Props {
  loanId: string
  clientName: string
  clientPhone: string
  loanReference: string
}

const CHANNELS = [
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "both", label: "SMS + WhatsApp" },
] as const

export type ReminderDelivery = {
  channel: string
  outcome: "sent" | "simulated" | "pending" | "reconciliation_required" | "blocked" | "failed"
  messageId?: string
  detail?: string
}

export type UnresolvedReminderChannel = "SMS" | "WhatsApp"

export function reminderOutcomeNotice(deliveries: ReminderDelivery[]): {
  level: "success" | "warning"
  title: string
  detail: string
} {
  const detail = deliveries.map((item) => {
    const state = item.outcome.replaceAll("_", " ")
    const extra = item.detail ? ` (${item.detail})` : ""
    return `${item.channel}: ${state}${extra}`
  }).join("; ")
  const allSent = deliveries.length > 0 && deliveries.every((item) => item.outcome === "sent")
  return allSent
    ? { level: "success", title: "Reminder sent", detail }
    : { level: "warning", title: "Reminder outcomes recorded", detail }
}

export function unresolvedReminderChannelsAfterDeliveries(
  previous: readonly UnresolvedReminderChannel[],
  deliveries: readonly ReminderDelivery[],
): UnresolvedReminderChannel[] {
  const unresolved = new Set(previous)
  for (const delivery of deliveries) {
    if (delivery.channel !== "SMS" && delivery.channel !== "WhatsApp") continue
    if (delivery.outcome === "pending" || delivery.outcome === "reconciliation_required") {
      unresolved.add(delivery.channel)
    } else if (delivery.outcome === "sent" || delivery.outcome === "simulated") {
      // A replay of the exact channel-scoped reservation returning sent is
      // affirmative provider-acceptance evidence for that leg.
      unresolved.delete(delivery.channel)
    }
  }
  return (["SMS", "WhatsApp"] as const).filter((channel) => unresolved.has(channel))
}

export function mayReleaseReminderOperationId(
  deliveries: readonly ReminderDelivery[],
  previousUnresolved: readonly UnresolvedReminderChannel[] = [],
): boolean {
  return deliveries.length > 0
    && deliveries.every((item) => item.outcome === "sent" || item.outcome === "simulated")
    && unresolvedReminderChannelsAfterDeliveries(previousUnresolved, deliveries).length === 0
}

export function operationIdAfterReminderChannelSelection(
  operationId: string | null,
  _currentChannel: "sms" | "whatsapp" | "both",
  _nextChannel: "sms" | "whatsapp" | "both",
): string | null {
  // The API derives a separate reservation key for each channel from this
  // operation id. Preserve the group id when narrowing/expanding the channel
  // selection so an unresolved SMS leg from a prior "both" attempt reuses its
  // exact SMS reservation, while a newly added WhatsApp leg still gets its own
  // channel-scoped key.
  return operationId
}

// Build the staff-editable default reminder. Quotes the loan reference
// (Loan.reference) — the token the bank-sync reconciler EXACT-matches on —
// so the client is told which reference to use when they pay. Exported for
// unit tests.
export function defaultReminderMessage(clientName: string, loanReference: string): string {
  const firstName = clientName.split(" ")[0]
  // Kept within one 160-char GSM-7 SMS segment (≈142 chars with a typical
  // reference) so a default send stays a single billed segment.
  return `Hi ${firstName}, a reminder about your outstanding payment. Please quote reference ${loanReference} when paying, or contact us about payment arrangements.`
}

export function ManualReminderButton({ loanId, clientName, clientPhone, loanReference }: Props) {
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<"sms" | "whatsapp" | "both">("sms")
  const [message, setMessage] = useState(() => defaultReminderMessage(clientName, loanReference))
  const [sending, setSending] = useState(false)
  const operationId = useRef<string | null>(null)
  const unresolvedChannels = useRef<UnresolvedReminderChannel[]>([])
  const operationTarget = useRef(loanId)

  useEffect(() => {
    if (operationTarget.current === loanId) return
    operationTarget.current = loanId
    operationId.current = null
    unresolvedChannels.current = []
    setOpen(false)
    setChannel("sms")
    setMessage(defaultReminderMessage(clientName, loanReference))
    setSending(false)
  }, [clientName, loanId, loanReference])

  function openDialog() {
    operationId.current ??= crypto.randomUUID()
    setOpen(true)
  }

  async function send() {
    if (!message.trim()) return
    setSending(true)
    const currentOperationId = operationId.current ?? crypto.randomUUID()
    operationId.current = currentOperationId
    const submittedLoanId = loanId
    try {
      const res = await fetch(`/api/collections/${loanId}/reminder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, message, operationId: currentOperationId }),
      })
      const data = await res.json()
      if (operationTarget.current !== submittedLoanId) return
      if (data.ok) {
        const deliveries = Array.isArray(data.deliveries) ? data.deliveries as ReminderDelivery[] : []
        const notice = reminderOutcomeNotice(deliveries)
        const doNotResend = deliveries.some((item) => item.outcome === "pending" || item.outcome === "reconciliation_required")
          ? " Do not resend; reconcile or wait for the reserved message."
          : ""
        if (notice.level === "success") toast.success(notice.title, notice.detail)
        else toast.warning(notice.title, `${notice.detail}${doNotResend}`)
        const previousUnresolved = unresolvedChannels.current
        unresolvedChannels.current = unresolvedReminderChannelsAfterDeliveries(
          previousUnresolved,
          deliveries,
        )
        if (mayReleaseReminderOperationId(deliveries, previousUnresolved)) {
          operationId.current = null
          unresolvedChannels.current = []
        }
        setOpen(false)
      } else {
        toast.error("Failed to send", data.error)
      }
    } catch {
      if (operationTarget.current === submittedLoanId) {
        toast.error("Network error", "If you submit again, the same protected operation will be checked before any resend.")
      }
    } finally {
      if (operationTarget.current === submittedLoanId) setSending(false)
    }
  }

  return (
    <>
      <button
        onClick={openDialog}
        className="px-3 py-1.5 rounded text-[12px] font-semibold border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
      >
        Send Reminder
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-[#1b1d24] text-lg">Send Reminder</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl">
                &times;
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-1">{clientName}</p>
            <p className="text-xs text-gray-400 mb-4">Phone: {clientPhone}</p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#1b1d24] mb-1">Channel</label>
                <div className="flex gap-2">
                  {CHANNELS.map((ch) => (
                    <button
                      key={ch.value}
                      type="button"
                      onClick={() => {
                        operationId.current = operationIdAfterReminderChannelSelection(
                          operationId.current,
                          channel,
                          ch.value,
                        )
                        setChannel(ch.value)
                      }}
                      className={`flex-1 py-2 text-sm font-semibold rounded-lg border ${
                        channel === ch.value
                          ? "bg-[#4F46E5] text-white border-[#4F46E5]"
                          : "border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      {ch.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[#1b1d24] mb-1">Message</label>
                <textarea
                  value={message}
                  onChange={(e) => {
                    // A changed payload is normally a new operation. When a
                    // prior channel is still provider-uncertain, keep the key
                    // so the server rejects a conflicting resend rather than
                    // issuing a fresh reservation beside the unknown attempt.
                    if (unresolvedChannels.current.length === 0) {
                      operationId.current = null
                    }
                    setMessage(e.target.value)
                  }}
                  rows={4}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] focus:ring-1 focus:ring-[#4F46E5] resize-none"
                />
                <p className="text-xs text-gray-400 mt-1">{message.length} / 160 characters</p>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-5">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 border border-gray-200 text-sm rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={send}
                disabled={sending || !message.trim()}
                className="px-5 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA] disabled:opacity-50"
              >
                {sending ? "Sending\u2026" : "Send Reminder"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
