"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { MessageCircle, Send, XCircle, CheckCircle, Info } from "lucide-react"
import { messageOperationIdAfterOutcome } from "@/lib/messaging/delivery-outcome"

interface Props {
  clientId: string
  clientName: string
  phone: string
  isOpen: boolean
  onClose: () => void
  onSent?: () => void
  defaultDpdBucket?: string
}

const DPD_TEMPLATES: Record<string, string> = {
  current: "Hi {name}, your loan payment is due soon. Please ensure funds are available. Contact us if you need assistance.",
  dpd_1: "Hi {name}, your payment was due yesterday. Please pay immediately to avoid further default interest and charges. Contact us if you're experiencing difficulty.",
  dpd_3: "⚠️ {name}, your account is 3 days overdue. Please contact us urgently to resolve this matter.",
  dpd_7: "🚨 URGENT {name} — your account is 7+ days overdue. Contact us immediately to avoid further action.",
  dpd_14: "⚠️ FINAL NOTICE {name} — your account is 14+ days overdue. We will proceed with collections action if payment is not received immediately.",
}

export function SendWhatsAppModal({ clientId, clientName, phone, isOpen, onClose, onSent, defaultDpdBucket }: Props) {
  const [dpdBucket, setDpdBucket] = useState(defaultDpdBucket ?? "current")
  const [customMessage, setCustomMessage] = useState("")
  const [useCustom, setUseCustom] = useState(false)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; simulated?: boolean; message: string } | null>(null)
  const operationId = useRef<string | null>(null)
  const requestTarget = `${clientId}\u0000${clientName}\u0000${phone}`
  const operationTarget = useRef(requestTarget)
  const wasOpen = useRef(false)
  const openGeneration = useRef(0)
  const successCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSuccessCloseTimer = useCallback(() => {
    if (successCloseTimer.current !== null) {
      clearTimeout(successCloseTimer.current)
      successCloseTimer.current = null
    }
  }, [])

  useEffect(() => {
    const targetChanged = operationTarget.current !== requestTarget
    if (targetChanged) {
      openGeneration.current += 1
      clearSuccessCloseTimer()
      operationTarget.current = requestTarget
      operationId.current = null
      setDpdBucket(defaultDpdBucket ?? "current")
      setCustomMessage("")
      setUseCustom(false)
      setResult(null)
      setSending(false)
    } else if (isOpen !== wasOpen.current) {
      openGeneration.current += 1
      clearSuccessCloseTimer()
      if (isOpen && operationId.current === null) {
        setDpdBucket(defaultDpdBucket ?? "current")
        setCustomMessage("")
        setUseCustom(false)
        setResult(null)
      }
    }
    wasOpen.current = isOpen
  }, [clearSuccessCloseTimer, defaultDpdBucket, isOpen, requestTarget])

  useEffect(() => () => clearSuccessCloseTimer(), [clearSuccessCloseTimer])

  const handleSend = async () => {
    const finalMessage = useCustom
      ? customMessage
      : DPD_TEMPLATES[dpdBucket]?.replace("{name}", clientName) || DPD_TEMPLATES.current

    if (!finalMessage.trim()) {
      setResult({ ok: false, message: "Message cannot be empty" })
      return
    }

    setSending(true)
    setResult(null)
    const currentOperationId = operationId.current ?? crypto.randomUUID()
    operationId.current = currentOperationId
    const submittedTarget = requestTarget
    const submittedGeneration = openGeneration.current

    try {
      const res = await fetch("/api/crm/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, message: finalMessage, operationId: currentOperationId }),
      })

      const data = await res.json() as {
        ok?: boolean
        error?: string
        messageId?: string
        simulated?: boolean
        pending?: boolean
        reconciliationRequired?: boolean
      }
      if (
        operationTarget.current !== submittedTarget
        || openGeneration.current !== submittedGeneration
      ) return

      if (res.ok && data.ok) {
        const outcome = data.reconciliationRequired || data.pending
          ? "pending"
          : data.simulated
            ? "simulated"
            : "sent"
        operationId.current = messageOperationIdAfterOutcome(
          operationId.current,
          outcome,
          data.reconciliationRequired === true,
        )
        if (data.reconciliationRequired) {
          setResult({ ok: true, message: `Provider outcome requires reconciliation. Do not resend. Message ID: ${data.messageId}` })
        } else if (data.pending) {
          setResult({ ok: true, message: `Message is queued or retrying. Do not create a duplicate. ID: ${data.messageId}` })
        } else if (data.simulated) {
          setResult({ ok: true, simulated: true, message: `Simulated — no WhatsApp message was sent. ID: ${data.messageId}` })
        } else {
          setResult({ ok: true, message: `Message sent! ID: ${data.messageId}` })
          clearSuccessCloseTimer()
          successCloseTimer.current = setTimeout(() => {
            successCloseTimer.current = null
            if (
              operationTarget.current !== submittedTarget
              || openGeneration.current !== submittedGeneration
            ) return
            onSent?.()
            onClose()
          }, 1500)
        }
      } else {
        setResult({ ok: false, message: data.error ?? "Failed to send" })
      }
    } catch {
      if (
        operationTarget.current !== submittedTarget
        || openGeneration.current !== submittedGeneration
      ) return
      setResult({ ok: false, message: "Network error" })
    } finally {
      if (
        operationTarget.current === submittedTarget
        && openGeneration.current === submittedGeneration
      ) setSending(false)
    }
  }

  if (!isOpen) return null

  const message = useCustom ? customMessage : DPD_TEMPLATES[dpdBucket]?.replace("{name}", clientName)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg max-w-md w-full max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MessageCircle className="h-5 w-5" style={{ color: "#25D366" }} />
            <h2 className="font-semibold text-gray-900">Send WhatsApp</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XCircle className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <div>
            <p className="text-xs font-medium text-gray-500">TO</p>
            <p className="text-sm font-semibold text-gray-900 mt-1">
              {clientName} • {phone}
            </p>
          </div>

          {!useCustom && (
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-2">TEMPLATE (DPD bucket)</label>
              <select
                value={dpdBucket}
                onChange={(e) => {
                  setDpdBucket(e.target.value)
                }}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#25D366]"
              >
                <option value="current">Current (payment due)</option>
                <option value="dpd_1">DPD 1 (1 day overdue)</option>
                <option value="dpd_3">DPD 3 (3 days overdue)</option>
                <option value="dpd_7">DPD 7 (7+ days overdue)</option>
                <option value="dpd_14">DPD 14+ (14+ days overdue)</option>
              </select>
            </div>
          )}

          <div>
            <label className="flex items-center gap-2 mb-2">
              <input
                type="checkbox"
                checked={useCustom}
                onChange={(e) => {
                  setUseCustom(e.target.checked)
                }}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs font-medium text-gray-600">Use custom message</span>
            </label>
            <textarea
              value={useCustom ? customMessage : message}
              onChange={(e) => {
                if (!useCustom) return
                setCustomMessage(e.target.value)
              }}
              readOnly={!useCustom}
              className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-[#25D366] disabled:bg-gray-50"
              rows={6}
              placeholder="Message preview..."
            />
            <p className="text-[11px] text-gray-400 mt-1.5">
              {useCustom && customMessage.length > 0 && `${customMessage.length} characters`}
            </p>
          </div>

          {result && (
            <div className={`flex items-center gap-2 text-sm px-3 py-2.5 rounded-md ${result.simulated ? "bg-amber-50 text-amber-700" : result.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
              {result.simulated ? <Info className="h-4 w-4 flex-shrink-0" /> : result.ok ? <CheckCircle className="h-4 w-4 flex-shrink-0" /> : <XCircle className="h-4 w-4 flex-shrink-0" />}
              <span>{result.message}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-md text-gray-700 text-sm font-medium hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !message?.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-md text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: "#25D366" }}
          >
            <Send className="h-3.5 w-3.5" />
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  )
}
