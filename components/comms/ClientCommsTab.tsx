"use client"

import { useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ConversationView } from "@/components/comms/ConversationView"
import type { ContactComms, TimelineMessage } from "@/lib/inbox/contact-comms"
import type { CannedReplyDTO } from "@/app/(dashboard)/inbox/types"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { mayReleaseMessageOperationId } from "@/lib/messaging/delivery-outcome"

type Props = {
  clientId: string
  hasContact: boolean
  comms: ContactComms
  cannedReplies: CannedReplyDTO[]
  currentUserId?: string
}

const CHANNEL_BADGE: Record<string, string> = {
  EMAIL: "bg-sky-100 text-sky-800",
  WHATSAPP: "bg-emerald-100 text-emerald-800",
  SMS: "bg-violet-100 text-violet-800",
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: SAST_TIME_ZONE })
}

function TimelineRow({ m, onReply }: { m: TimelineMessage; onReply: (conversationId: string) => void }) {
  const inbound = m.direction === "INBOUND"
  return (
    <div className="flex items-start gap-3 border-b border-gray-100 py-2">
      <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${CHANNEL_BADGE[m.channel] ?? "bg-gray-100 text-gray-700"}`}>{m.channel}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-gray-800">
          {m.deletedAt
            ? <span className="italic text-gray-400">Note deleted by {m.deletedByName ?? "a colleague"}</span>
            : <>
                {m.isInternal ? <span className="text-amber-600">Note: </span> : <span className="text-gray-400">{inbound ? "← " : "→ "}</span>}
                {m.bodyText ?? (m.hasMedia ? "(attachment)" : "")}
                {m.editedAt && <span className="ml-1 italic text-gray-400">edited</span>}
              </>}
        </p>
        <p className="text-[11px] text-gray-400">{timeLabel(m.createdAt)} · {m.status}{m.createdByName ? ` · ${m.createdByName}` : ""}</p>
      </div>
      <button onClick={() => onReply(m.conversationId)} className="text-[11px] text-blue-600 hover:underline">Reply</button>
    </div>
  )
}

export function ClientCommsTab(props: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<"timeline" | "threads">("timeline")
  const [selectedId, setSelectedId] = useState<string | null>(props.comms.conversations[0]?.id ?? null)
  const selectedIdRef = useRef<string | null>(selectedId)
  const [busy, setBusy] = useState(false)
  const [fallback, setFallback] = useState<{ reason: string; detail?: string } | null>(null)

  const byConversation = useMemo(() => {
    const map = new Map<string, TimelineMessage[]>()
    for (const m of props.comms.messages) {
      const list = map.get(m.conversationId) ?? []
      list.push(m)
      map.set(m.conversationId, list)
    }
    return map
  }, [props.comms.messages])

  const selected = props.comms.conversations.find((c) => c.id === selectedId) ?? null

  // Proactively surface a consent/availability block for the selected channel
  // (opted out, no address on file, WhatsApp off) before the agent types; once
  // they attempt a send, the post-send failure reason takes over.
  const selectedAvail = selected
    ? props.comms.channelAvailability[selected.channel as "EMAIL" | "WHATSAPP" | "SMS"]
    : undefined
  const composerFallback = fallback
    ?? (selectedAvail && !selectedAvail.enabled ? { reason: "CHANNEL_DISABLED", detail: selectedAvail.reason } : null)

  function selectThread(conversationId: string) {
    selectedIdRef.current = conversationId
    setSelectedId(conversationId)
    setFallback(null)
  }

  function openThread(conversationId: string) {
    selectThread(conversationId)
    setMode("threads")
  }

  async function sendReply(conversationId: string, text: string, operationId: string, channel: string): Promise<boolean> {
    setBusy(true)
    setFallback(null)
    try {
      const res = await fetch(`/api/clients/${props.clientId}/comms/threads/${conversationId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, operationId, channel }),
      })
      const data = (await res.json()) as { ok?: boolean; outcome?: "sent" | "simulated" | "pending"; reason?: string; detail?: string; reconciliationRequired?: boolean }
      if (data.ok) {
        if (selectedIdRef.current === conversationId) {
          setFallback(data.reconciliationRequired
            ? { reason: "RECONCILIATION_REQUIRED" }
            : data.outcome === "simulated"
              ? { reason: "SIMULATED" }
              : data.outcome === "pending"
                ? { reason: "PENDING" }
                : null)
        }
        router.refresh() // re-run the server load so the new message appears
        return mayReleaseMessageOperationId(data.outcome, data.reconciliationRequired === true)
      } else {
        if (selectedIdRef.current === conversationId) {
          setFallback({ reason: data.reason ?? "SEND_FAILED", detail: data.detail })
        }
        return false
      }
    } catch {
      if (selectedIdRef.current === conversationId) setFallback({ reason: "SEND_FAILED" })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addNote(conversationId: string, text: string, mentionUserIds: string[]): Promise<boolean> {
    setBusy(true)
    setFallback(null) // matches sendReply: don't leave a stale failure banner over a fresh attempt
    try {
      const res = await fetch(`/api/clients/${props.clientId}/comms/threads/${conversationId}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mentionUserIds }),
      })
      if (!res.ok) {
        if (selectedIdRef.current === conversationId) setFallback({ reason: "NOTE_FAILED" })
        return false
      }
      router.refresh() // re-run the server load so the new note appears
      return true
    } catch {
      if (selectedIdRef.current === conversationId) setFallback({ reason: "NOTE_FAILED" })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function editNote(noteId: string, text: string, mentionUserIds: string[]): Promise<boolean> {
    const conversationId = selectedIdRef.current
    if (!conversationId) return false
    setBusy(true)
    setFallback(null) // matches sendReply/addNote: don't leave a stale failure banner over a fresh attempt
    try {
      const res = await fetch(`/api/clients/${props.clientId}/comms/threads/${conversationId}/note/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mentionUserIds }),
      })
      if (!res.ok) {
        if (selectedIdRef.current === conversationId) setFallback({ reason: "NOTE_EDIT_FAILED" })
        return false
      }
      router.refresh()
      return true
    } catch {
      if (selectedIdRef.current === conversationId) setFallback({ reason: "NOTE_EDIT_FAILED" })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function deleteNote(noteId: string): Promise<boolean> {
    const conversationId = selectedIdRef.current
    if (!conversationId) return false
    setBusy(true)
    setFallback(null)
    try {
      const res = await fetch(`/api/clients/${props.clientId}/comms/threads/${conversationId}/note/${noteId}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        if (selectedIdRef.current === conversationId) setFallback({ reason: "NOTE_DELETE_FAILED" })
        return false
      }
      router.refresh()
      return true
    } catch {
      if (selectedIdRef.current === conversationId) setFallback({ reason: "NOTE_DELETE_FAILED" })
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!props.hasContact) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">
        This client has no contact record. Contact provisioning happens automatically for new clients — for legacy records, ask an administrator to add one before messaging this client.
      </p>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-1 border-b border-gray-200 p-2 text-sm">
        <button onClick={() => setMode("timeline")} className={`rounded px-3 py-1 ${mode === "timeline" ? "bg-gray-900 text-white" : "text-gray-600"}`}>Timeline</button>
        <button onClick={() => setMode("threads")} className={`rounded px-3 py-1 ${mode === "threads" ? "bg-gray-900 text-white" : "text-gray-600"}`}>Threads</button>
      </div>

      {mode === "timeline" && (
        <div className="max-h-[32rem] overflow-y-auto px-4 py-2">
          {props.comms.messages.length === 0
            ? <p className="py-8 text-center text-sm text-gray-400">No messages yet. Use the “Message client” button above to start a conversation.</p>
            : props.comms.messages.map((m) => <TimelineRow key={m.id} m={m} onReply={openThread} />)}
        </div>
      )}

      {mode === "threads" && (
        <div className="grid grid-cols-[14rem_1fr] gap-0" style={{ height: "32rem" }}>
          <div className="overflow-y-auto border-r border-gray-200">
            {props.comms.conversations.length === 0 && <p className="p-3 text-xs text-gray-400">No conversations.</p>}
            {props.comms.conversations.map((c) => (
              <div key={c.id} className={`border-b border-gray-100 px-3 py-2 ${c.id === selectedId ? "bg-gray-100" : ""}`}>
                <button onClick={() => selectThread(c.id)} className="block w-full text-left text-xs">
                  <span className={`rounded px-1 py-0.5 text-[10px] ${CHANNEL_BADGE[c.channel] ?? "bg-gray-100 text-gray-700"}`}>{c.channel}</span>
                  <span className="ml-2 text-gray-500">{c.messageCount} msg{c.messageCount === 1 ? "" : "s"}</span>
                  <span className="block truncate text-gray-400">{c.subject ?? c.status}</span>
                </button>
                <Link href={`/inbox?conversationId=${c.id}`} target="_blank" rel="noopener" className="text-[11px] text-blue-600 hover:underline">Open in Inbox</Link>
              </div>
            ))}
          </div>
          <div className="min-h-0">
            {selected
              ? <ConversationView
                  conversationId={selected.id}
                  messages={byConversation.get(selected.id) ?? []}
                  channel={selected.channel}
                  window={selected.channel === "WHATSAPP" ? props.comms.waWindow : null}
                  cannedReplies={props.cannedReplies}
                  busy={busy}
                  fallback={composerFallback}
                  currentUserId={props.currentUserId}
                  availableChannels={props.comms.replyChannels ?? [selected.channel]}
                  defaultChannel={selected.channel}
                  onSend={sendReply}
                  onNote={addNote}
                  onEditNote={editNote}
                  onDeleteNote={deleteNote}
                />
              : <p className="p-6 text-center text-sm text-gray-400">Select a conversation.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
