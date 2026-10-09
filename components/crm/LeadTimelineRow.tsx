"use client"

import Link from "next/link"
import { Phone, Mail, MessageSquare, FileText, Star, Calendar, MessageCircle, ArrowDownLeft, ArrowUpRight, Bot } from "lucide-react"
import { statusLabel } from "@/components/messaging/message-status"
import { leadMessageHeadline } from "./lead-message-headline"
import type { LeadTimelineEntry } from "@/lib/crm/lead-timeline"
import { splitNoteLinks } from "@/lib/inbox/note-links"
import { CHAT_STARTED_ACTIVITY_SUBJECT } from "@/lib/website-chat/constants"

const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  CALL: Phone, EMAIL: Mail, WHATSAPP: MessageSquare,
  MEETING: Calendar, NOTE: FileText, FOLLOW_UP: Star,
  LOAN_OFFER: FileText, INSURANCE_OFFER: FileText,
}

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  EMAIL: Mail, WHATSAPP: MessageSquare, SMS: MessageCircle, CHATBOT: Bot,
}
const CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "Email", WHATSAPP: "WhatsApp", SMS: "SMS", CHATBOT: "Website chat",
}

// Explicit timeZone: without it, formatting resolves to the JS runtime's
// local zone, which differs between the server (SSR, typically UTC) and the
// browser (SAST) — a text mismatch that trips React hydration (#418).
export const SAST_TIME_ZONE = "Africa/Johannesburg"

export function timeAgo(date: Date) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(date).toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: SAST_TIME_ZONE })
}

export function ActivityRow({ entry }: { entry: Extract<LeadTimelineEntry, { kind: "activity" }> }) {
  const Icon = ACTIVITY_ICONS[entry.type] ?? FileText
  return (
    <div className="px-5 py-4 flex gap-3">
      <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Icon className="h-3.5 w-3.5 text-gray-500" />
      </div>
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-gray-900">{entry.subject}</p>
          <span className="text-[11px] text-gray-400">{timeAgo(entry.createdAt)}</span>
        </div>
        <span className="text-[10px] font-semibold text-gray-400 uppercase">{entry.type.replace(/_/g, " ")}</span>
        {entry.notes && (
          <p className="text-sm text-gray-600 mt-1">
            {/* Only the website chat's own activity links its inbox thread (plain <a>, fixed
                same-origin paths). Other activities quote visitor text verbatim, newlines
                included, so a visitor could type the chat's label line into them. */}
            {entry.subject === CHAT_STARTED_ACTIVITY_SUBJECT
              ? splitNoteLinks(entry.notes).map((p, i) => (
                  p.href ? <a key={i} href={p.href} className="underline break-all">{p.text}</a> : <span key={i}>{p.text}</span>
                ))
              : entry.notes}
          </p>
        )}
      </div>
    </div>
  )
}

export function MessageRow({ entry }: { entry: Extract<LeadTimelineEntry, { kind: "message" }> }) {
  const Icon = CHANNEL_ICONS[entry.channel] ?? MessageSquare
  const outbound = entry.direction === "OUTBOUND"
  const channelLabel = CHANNEL_LABELS[entry.channel] ?? entry.channel
  return (
    <div className="px-5 py-4 flex gap-3">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${outbound ? "bg-amber-50" : "bg-emerald-50"}`}>
        <Icon className={`h-3.5 w-3.5 ${outbound ? "text-amber-600" : "text-emerald-600"}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
            {outbound
              ? <ArrowUpRight className="h-3.5 w-3.5 text-amber-500" />
              : <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-500" />}
            {leadMessageHeadline({
              channelLabel,
              direction: entry.direction,
              status: entry.status,
            })}
            {outbound && entry.createdByName && <span className="font-normal text-gray-400">by {entry.createdByName}</span>}
          </p>
          <span className="text-[11px] text-gray-400 flex-shrink-0">{timeAgo(entry.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-gray-400 uppercase">{channelLabel}</span>
          {outbound && <span className="text-[10px] text-gray-400">{statusLabel(entry.status)}</span>}
          <Link href={`/inbox?conversationId=${entry.conversationId}`} className="text-[10px] text-blue-600 hover:underline">
            Open in Inbox
          </Link>
        </div>
        {entry.bodyText && <p className="text-sm text-gray-600 mt-1 line-clamp-2 break-words">{entry.bodyText}</p>}
        {entry.hasMedia && <p className="text-[11px] text-gray-400 mt-0.5">Includes an attachment</p>}
      </div>
    </div>
  )
}
