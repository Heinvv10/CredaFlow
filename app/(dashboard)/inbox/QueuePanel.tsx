"use client"

import { Badge } from "@/components/ui/badge"
import type { ConversationSummary, InboxQueue } from "./types"

const QUEUE_TABS: { key: InboxQueue; label: string }[] = [
  { key: "unassigned", label: "Unassigned" },
  { key: "mine", label: "Mine" },
  { key: "all", label: "All" },
  { key: "closed", label: "Closed" },
]

const PRIORITY_STYLE: Record<string, string> = {
  NORMAL: "hidden",
  HIGH: "bg-orange-100 text-orange-800",
  URGENT: "bg-red-100 text-red-800",
}

function relTime(iso: string | null): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

type Props = {
  queue: InboxQueue
  onQueueChange: (q: InboxQueue) => void
  conversations: ConversationSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  search: string
  onSearchChange: (v: string) => void
  loading: boolean
}

export function QueuePanel(props: Props) {
  const q = props.search.trim().toLowerCase()
  const filtered = q
    ? props.conversations.filter(
        (c) => c.contactName.toLowerCase().includes(q) || (c.primaryPhone ?? "").includes(q) || (c.lastMessagePreview ?? "").toLowerCase().includes(q),
      )
    : props.conversations

  return (
    <div className="flex h-full flex-col border-r border-gray-200 bg-gray-50">
      <div className="flex border-b border-gray-200">
        {QUEUE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => props.onQueueChange(t.key)}
            className={`flex-1 px-3 py-2 text-sm font-medium ${
              props.queue === t.key ? "border-b-2 border-amber-500 text-amber-700" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-2">
        <input
          type="search"
          value={props.search}
          onChange={(e) => props.onSearchChange(e.target.value)}
          placeholder="Search conversations…"
          className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {props.loading && filtered.length === 0 ? (
          <p className="p-4 text-center text-sm text-gray-400">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-center text-sm text-gray-400">No conversations.</p>
        ) : (
          filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => props.onSelect(c.id)}
              // hover:bg-white is NOT covered by the theme remap (only the
              // hover:bg-gray-50/100 variants are) — it painted literal white
              // over dark-theme text. hover:bg-gray-50 uses the remapped
              // "raised" tone instead. Selected uses a separate accent (bronze
              // tint + amber left rail) so it stays distinguishable from hover
              // even when a selected row is also hovered — the amber rail is a
              // different CSS property than the hover background, so it survives.
              className={`flex w-full flex-col gap-0.5 border-b border-l-2 border-gray-100 px-3 py-2 text-left hover:bg-gray-50 ${
                props.selectedId === c.id ? "border-l-amber-500 bg-[var(--cf-surface-strong)]" : "border-l-transparent"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="truncate font-medium text-gray-900">{c.contactName}</span>
                <span className="ml-2 shrink-0 text-[10px] text-gray-400">{relTime(c.lastMessageAt)}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="truncate text-xs text-gray-500">{c.lastMessagePreview ?? "—"}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1">
                <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">{c.channel === "CHATBOT" ? "Website chat" : c.channel}</Badge>
                {c.priority !== "NORMAL" && <Badge className={`text-[10px] ${PRIORITY_STYLE[c.priority]}`}>{c.priority}</Badge>}
                {c.assigneeName && <span className="text-[10px] text-gray-400">→ {c.assigneeName}</span>}
                {c.unreadCount > 0 && (
                  <span className="ml-auto rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">{c.unreadCount}</span>
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
