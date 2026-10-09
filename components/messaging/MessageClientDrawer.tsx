"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ChannelPicker, CHANNEL_ORDER, type Channel, type ChannelAvail, type ChannelAvailability } from "./ChannelPicker"
import { statusLabel, TERMINAL_STATUSES, FAILED_STATUSES, SUCCESS_STATUSES } from "./message-status"
import {
  messageOperationIdAfterChannelSelection,
  messageOperationIdAfterOutcome,
} from "@/lib/messaging/delivery-outcome"

type CannedReply = { id: string; title: string; body: string }
type Attachment = { id: string; filename: string; contentType: string; contentBase64: string; size: number }

export type MessageClientDrawerProps = {
  open: boolean
  onClose: () => void
  clientId: string
  clientName: string
  cannedReplies: CannedReply[]
  initialChannel?: Channel
  prefill?: { subject?: string; body?: string }
  loanId?: string
  // API prefix for the {channel-availability, messages, messages/:id} routes.
  // Defaults to the client routes; the lead page passes /api/crm/leads/:id so
  // the same drawer composes to a Lead's Contact.
  apiBase?: string
}

type SendPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "polling"; status: string }
  | { kind: "done"; status: string }
  | { kind: "error"; message: string }

const DEFAULT_SUBJECT = "A message from us"
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const POLL_INTERVAL_MS = 3000
const POLL_MAX_ATTEMPTS = 10

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
    reader.readAsDataURL(file)
  })
}

const inputCls = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] focus:ring-1 focus:ring-[#4F46E5]"
const labelCls = "block text-sm font-medium text-[#1b1d24] mb-1"

const BANNER_CLASSES = {
  polling: "bg-blue-50 border-blue-200 text-blue-900",
  success: "bg-emerald-50 border-emerald-200 text-emerald-800",
  failure: "bg-red-50 border-red-200 text-red-800",
  neutral: "bg-amber-50 border-amber-200 text-amber-800",
} as const

// Only a genuinely successful terminal status (SENT/DELIVERED/READ) gets the
// green "done" styling. FAILED-ish statuses get red. Everything else that
// ends the poll — cap reached while still QUEUED/RETRYING, or the UNKNOWN
// network-error branch — is neither confirmed success nor confirmed failure,
// so it gets a neutral banner rather than a false green "success".
function sendBanner(send: SendPhase): { tone: keyof typeof BANNER_CLASSES; text: string } | null {
  if (send.kind === "polling") {
    return { tone: "polling", text: `${statusLabel(send.status)}… Appears in the Inbox.` }
  }
  if (send.kind !== "done") return null
  if (FAILED_STATUSES.has(send.status)) {
    return { tone: "failure", text: `${statusLabel(send.status)}. Appears in the Inbox.` }
  }
  if (SUCCESS_STATUSES.has(send.status)) {
    return { tone: "success", text: `${statusLabel(send.status)}. Appears in the Inbox.` }
  }
  if (send.status === "SIMULATED") {
    return { tone: "neutral", text: `${statusLabel(send.status)}. Appears in the Inbox.` }
  }
  if (send.status === "RECONCILIATION_REQUIRED") {
    return {
      tone: "neutral",
      text: "Manual reconciliation required — automatic retry is blocked. Open the Inbox reconciliation queue.",
    }
  }
  return { tone: "neutral", text: "Still sending — it will appear in the Inbox." }
}

export function MessageClientDrawer(props: MessageClientDrawerProps) {
  const { open, onClose, clientId, clientName, cannedReplies, initialChannel, prefill, loanId } = props
  const apiBase = props.apiBase ?? `/api/clients/${clientId}`
  const requestScope = `${apiBase}\u0000${loanId ?? ""}`
  const router = useRouter()

  const [availability, setAvailability] = useState<ChannelAvailability | null>(null)
  const [channel, setChannel] = useState<Channel | null>(null)
  const [subject, setSubject] = useState(prefill?.subject ?? DEFAULT_SUBJECT)
  const [body, setBody] = useState(prefill?.body ?? "")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [send, setSend] = useState<SendPhase>({ kind: "idle" })
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const operationId = useRef<string | null>(null)
  const operationTarget = useRef(requestScope)
  const pendingMessageId = useRef<string | null>(null)
  const requestGeneration = useRef(0)

  // Reset the form and (re)fetch channel availability whenever the drawer opens.
  useEffect(() => {
    if (!open) return
    const targetChanged = operationTarget.current !== requestScope
    if (targetChanged) {
      requestGeneration.current += 1
      if (pollTimer.current) clearTimeout(pollTimer.current)
      pollTimer.current = null
      operationId.current = null
      pendingMessageId.current = null
      operationTarget.current = requestScope
    }
    // A retained operation id means the prior outcome was not definitely
    // accepted. Preserve the exact payload and key across close/reopen so an
    // unchanged retry can only recover the same durable reservation.
    const preserveProtectedRequest = !targetChanged && operationId.current !== null
    if (!preserveProtectedRequest) {
      setSubject(prefill?.subject ?? DEFAULT_SUBJECT)
      setBody(prefill?.body ?? "")
      setAttachments([])
      setAttachmentError(null)
      setSend({ kind: "idle" })
      setAvailability(null)
      setChannel(null)
    } else if (pendingMessageId.current) {
      // Closing cancels the timer, not the durable reservation. Resume status
      // checks on reopen so the retained request does not become a disabled,
      // permanently stuck form.
      setSend({ kind: "polling", status: "QUEUED" })
      const generation = requestGeneration.current
      const protectedOperationId = operationId.current
      const protectedMessageId = pendingMessageId.current
      pollTimer.current = setTimeout(
        () => pollStatus(
          protectedMessageId!,
          1,
          apiBase,
          requestScope,
          generation,
          protectedOperationId!,
        ),
        POLL_INTERVAL_MS,
      )
    }

    let cancelled = false
    fetch(`${apiBase}/channel-availability`)
      .then((r) => {
        if (!r.ok) throw new Error(`channel-availability responded ${r.status}`)
        return r.json() as Promise<ChannelAvailability>
      })
      .then((data) => {
        if (cancelled) return
        setAvailability(data)
        const preferred = initialChannel && data[initialChannel]?.enabled
          ? initialChannel
          : CHANNEL_ORDER.find((c) => data[c]?.enabled)
        if (!preserveProtectedRequest) setChannel(preferred ?? null)
      })
      .catch(() => {
        if (cancelled) return
        const failure: ChannelAvail = { enabled: false, reason: "Could not load channel availability." }
        setAvailability({ EMAIL: failure, WHATSAPP: failure, SMS: failure })
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clientId, apiBase, requestScope])

  // Stop any in-flight poll once the drawer closes or unmounts.
  useEffect(() => {
    if (!open) {
      requestGeneration.current += 1
      if (pollTimer.current) {
        clearTimeout(pollTimer.current)
        pollTimer.current = null
      }
    }
  }, [open])
  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current) }, [])

  function resetProtectedRequestForEdit(): number {
    requestGeneration.current += 1
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = null
    pendingMessageId.current = null
    // Editing a provider-uncertain request must keep its business key. The
    // server will reject a changed payload under that key instead of creating
    // a second reservation beside an unresolved provider submission.
    setSend({ kind: "idle" })
    return requestGeneration.current
  }

  if (!open) return null

  function insertCannedReply(id: string) {
    const reply = cannedReplies.find((r) => r.id === id)
    if (reply) {
      resetProtectedRequestForEdit()
      setBody((prev) => (prev ? `${prev}\n${reply.body}` : reply.body))
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    const generation = resetProtectedRequestForEdit()
    const fileScope = requestScope
    const existingSize = attachments.reduce((sum, a) => sum + a.size, 0)
    if (existingSize + file.size > MAX_ATTACHMENT_BYTES) {
      if (requestGeneration.current === generation && operationTarget.current === fileScope) {
        setAttachmentError("Attachments exceed the 10 MB limit.")
      }
      return
    }
    try {
      const contentBase64 = await fileToBase64(file)
      if (requestGeneration.current !== generation || operationTarget.current !== fileScope) return
      const id = crypto.randomUUID()
      setAttachments((prev) => [...prev, { id, filename: file.name, contentType: file.type || "application/octet-stream", contentBase64, size: file.size }])
      setAttachmentError(null)
    } catch {
      if (requestGeneration.current === generation && operationTarget.current === fileScope) {
        setAttachmentError("Could not read the selected file.")
      }
    }
  }

  function removeAttachment(id: string) {
    resetProtectedRequestForEdit()
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  function pollStatus(
    messageId: string,
    attempt: number,
    pollApiBase = apiBase,
    pollScope = requestScope,
    generation = requestGeneration.current,
    protectedOperationId = operationId.current,
  ) {
    fetch(`${pollApiBase}/messages/${messageId}`)
      .then((r) => r.json())
      .then((data: { status?: string }) => {
        if (
          operationTarget.current !== pollScope ||
          requestGeneration.current !== generation ||
          operationId.current !== protectedOperationId ||
          pendingMessageId.current !== messageId
        ) return
        const status = data.status ?? "QUEUED"
        if (SUCCESS_STATUSES.has(status)) {
          operationId.current = null
          pendingMessageId.current = null
        }
        if (TERMINAL_STATUSES.has(status) || attempt >= POLL_MAX_ATTEMPTS) {
          if (TERMINAL_STATUSES.has(status)) pendingMessageId.current = null
          setSend({ kind: "done", status })
          return
        }
        setSend({ kind: "polling", status })
        pollTimer.current = setTimeout(
          () => pollStatus(
            messageId,
            attempt + 1,
            pollApiBase,
            pollScope,
            generation,
            protectedOperationId,
          ),
          POLL_INTERVAL_MS,
        )
      })
      .catch(() => {
        if (
          operationTarget.current === pollScope &&
          requestGeneration.current === generation &&
          operationId.current === protectedOperationId &&
          pendingMessageId.current === messageId
        ) setSend({ kind: "done", status: "UNKNOWN" })
      })
  }

  async function handleSend() {
    if (!channel || body.trim() === "") return
    const currentOperationId = operationId.current ?? crypto.randomUUID()
    operationId.current = currentOperationId
    const submittedScope = requestScope
    requestGeneration.current += 1
    const generation = requestGeneration.current
    setSend({ kind: "sending" })
    try {
      const res = await fetch(`${apiBase}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          text: body.trim(),
          subject: channel === "EMAIL" ? subject : undefined,
          loanId,
          operationId: currentOperationId,
          attachments: channel === "EMAIL" && attachments.length > 0
            ? attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, contentBase64: a.contentBase64 }))
            : undefined,
        }),
      })
      const data = await res.json()
      if (
        operationTarget.current !== submittedScope ||
        requestGeneration.current !== generation ||
        operationId.current !== currentOperationId
      ) return
      if (res.ok) {
        operationId.current = messageOperationIdAfterOutcome(
          operationId.current,
          data.outcome,
          data.reconciliationRequired === true,
        )
        if (data.reconciliationRequired === true) {
          pendingMessageId.current = null
          setSend({ kind: "done", status: "RECONCILIATION_REQUIRED" })
          router.refresh()
          return
        }
        if (data.outcome === "simulated") {
          pendingMessageId.current = null
          setSend({ kind: "done", status: data.status ?? "SIMULATED" })
          router.refresh()
          return
        }
        if (data.outcome === "sent") {
          pendingMessageId.current = null
          setSend({ kind: "done", status: data.status ?? "SENT" })
          router.refresh()
          return
        }
        pendingMessageId.current = data.messageId
        setSend({ kind: "polling", status: data.status ?? "QUEUED" })
        router.refresh() // re-run the server load so the new message appears in the Comms tab
        pollTimer.current = setTimeout(
          () => pollStatus(
            data.messageId,
            1,
            apiBase,
            submittedScope,
            generation,
            currentOperationId,
          ),
          POLL_INTERVAL_MS,
        )
      } else if (typeof data.error === "string" && data.error.endsWith("has no contact")) {
        setSend({ kind: "error", message: "No contact record on file. Ask an administrator to add one before sending a message." })
      } else {
        setSend({ kind: "error", message: data.detail ?? data.reason ?? data.error ?? "Message could not be sent." })
      }
    } catch {
      if (
        operationTarget.current === submittedScope &&
        requestGeneration.current === generation &&
        operationId.current === currentOperationId
      ) {
        setSend({ kind: "error", message: "Network error — message could not be sent." })
      }
    }
  }

  const sending = send.kind === "sending" || send.kind === "polling"
  const banner = sendBanner(send)

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#1b1d24]">Message {clientName}</h2>
            <p className="text-xs text-gray-400">Sends to the client and appears in the Inbox.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <ChannelPicker availability={availability} channel={channel} onChange={(value) => {
            operationId.current = messageOperationIdAfterChannelSelection(
              operationId.current,
              channel,
              value,
            )
            if (value !== channel) resetProtectedRequestForEdit()
            setChannel(value)
          }} />

          {channel === "EMAIL" && (
            <div>
              <label className={labelCls}>Subject</label>
              <input className={inputCls} value={subject} onChange={(e) => {
                resetProtectedRequestForEdit()
                setSubject(e.target.value)
              }} />
            </div>
          )}

          {cannedReplies.length > 0 && (
            <div>
              <label className={labelCls}>Canned reply</label>
              <select
                className={inputCls}
                value=""
                onChange={(e) => { if (e.target.value) insertCannedReply(e.target.value) }}
              >
                <option value="">Insert canned reply…</option>
                {cannedReplies.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className={labelCls}>Message</label>
            <textarea
              rows={6}
              className={inputCls}
              value={body}
              onChange={(e) => {
                resetProtectedRequestForEdit()
                setBody(e.target.value)
              }}
              placeholder="Type a message…"
            />
          </div>

          {channel === "EMAIL" && (
            <div>
              <label className={labelCls}>
                Attachment <span className="text-gray-400 font-normal">(optional, max 10 MB total)</span>
              </label>
              <input type="file" onChange={handleFileChange} className="block w-full text-sm text-gray-600" />
              {attachments.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {attachments.map((a) => (
                    <li key={a.id} className="flex items-center justify-between rounded-md bg-gray-50 border border-gray-200 px-2 py-1 text-xs text-gray-600">
                      <span className="truncate">{a.filename} ({Math.ceil(a.size / 1024)} KB)</span>
                      <button type="button" onClick={() => removeAttachment(a.id)} className="ml-2 text-gray-400 hover:text-red-600">Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              {attachmentError && <p className="mt-1 text-xs text-red-600">{attachmentError}</p>}
            </div>
          )}

          {banner && (
            <div className={`rounded-md border px-3 py-2 text-xs ${BANNER_CLASSES[banner.tone]}`}>
              {banner.text}
            </div>
          )}
          {send.kind === "error" && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">{send.message}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-600 text-sm font-semibold rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !channel || body.trim() === ""}
            className="px-6 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA] disabled:opacity-50"
          >
            {send.kind === "sending" ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  )
}
