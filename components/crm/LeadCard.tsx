"use client"

import Link from "next/link"
import { CalendarClock, ClipboardList, Copy, MessageCircle, Phone, StickyNote, User } from "lucide-react"
import { cn, SAST_TIME_ZONE } from "@/lib/utils"
import type { TabKey } from "@/components/crm/LeadSlideOver"

// Kanban card for the leads pipeline. Split out of LeadKanban.tsx (which had
// grown past the 300-line cap) — the board imports the card plus the small
// shared helpers below.

export type KanbanLead = {
  id: string
  firstName: string
  lastName: string
  phone: string
  source: string
  status: string
  convertedToClientId: string | null
  convertedToApplicationId: string | null
  conversionRecoveryRequired: boolean
  assignedToId: string | null
  createdAt: Date
  updatedAt: Date
  statusChangedAt: Date
  callbackDate: Date | null
  leadScore: number | null
  /** Cents, like every Lead money field. */
  requestedAmount: number | null
  /** OTHER leads sharing this one's phone number; 0 = no duplicate. Computed
   *  whole-board by countDuplicatesByPhone, never per card. */
  duplicateCount: number
  _count: { activities: number }
}

export const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  WEBSITE: "Website",
  REFERRAL: "Referral",
  WALK_IN: "Walk-in",
  SOCIAL: "Social",
  WHATSAPP: "WhatsApp",
}

export function daysSince(date: Date) {
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000)
}

const sastDay = (d: Date) => d.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })

// THE definition of a late callback, shared by the card's red "LATE" badge
// and the board's "Needs attention" preset so they can never disagree: a
// callback from a PREVIOUS SAST day. One due earlier today is "due today",
// not late — it's still today's call.
function isCallbackLate(due: Date, now: Date): boolean {
  return sastDay(due) !== sastDay(now) && due < now
}

/** Close-style triage predicate: an OPEN lead that is late on a callback,
 *  stale, or unowned — the board's "Needs attention" preset. */
export function leadNeedsAttention(lead: KanbanLead): boolean {
  return (
    lead.status !== "CONVERTED" &&
    lead.status !== "LOST" &&
    ((lead.callbackDate !== null && isCallbackLate(new Date(lead.callbackDate), new Date())) ||
      daysSince(lead.updatedAt) > 3 ||
      lead.assignedToId === null)
  )
}

const SCORE_TIER = (score: number) => {
  if (score >= 80) return { label: "HOT", tone: "border-red-500/40 bg-red-500/12 text-red-200" }
  if (score >= 60) return { label: "WARM", tone: "border-amber-500/40 bg-amber-500/12 text-amber-200" }
  if (score >= 40) return { label: "COOL", tone: "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.12)] text-[var(--cf-brand-soft)]" }
  return { label: "COLD", tone: "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] text-[var(--cf-text-muted)]" }
}

function StalenessIndicator({ updatedAt }: { updatedAt: Date }) {
  const days = daysSince(updatedAt)

  if (days <= 1) {
    return <span className="text-[10px] text-[var(--cf-text-muted)]">{days}d</span>
  }

  if (days <= 3) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-amber-300">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
        {days}d
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1 text-[10px] font-medium text-red-300">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400" />
      {days}d
      <span className="rounded border border-red-500/30 bg-red-500/12 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-200">
        STALE
      </span>
    </span>
  )
}

const quickActionCls =
  "rounded p-1 text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-bg-subtle)] hover:text-[var(--cf-brand-soft)]"

/**
 * Pipedrive-style next-action state from the lead's callback: green = due
 * today (even if the time has passed — it's still today's call), red =
 * overdue from a previous day, amber = scheduled ahead, grey = nothing
 * scheduled. Day equality in SAST so the state flips at the business's
 * midnight, not UTC's.
 *
 * Rendered as a coloured CalendarClock glyph, NOT a bare dot: the adjacent
 * StalenessIndicator already speaks in red/amber dots, so a same-palette dot
 * 6px away would be unreadable at a glance. The icon shape marks WHICH signal
 * this is; it also matches the "Schedule callback" quick action below.
 */
function nextActionState(due: Date | null): { cls: string; label: string; text?: string } {
  if (!due) return { cls: "text-gray-500/70", label: "No callback scheduled" }
  const now = new Date()
  if (isCallbackLate(due, now)) return { cls: "text-red-400", label: "Callback overdue", text: "late" }
  if (sastDay(due) === sastDay(now)) return { cls: "text-emerald-400", label: "Callback due today", text: "today" }
  return { cls: "text-amber-400", label: "Callback scheduled" }
}

export function LeadCard({
  lead,
  onOpen,
  onCallback,
}: {
  lead: KanbanLead
  /** Open the lead modal on a specific tab ("details" for the plain name click). */
  onOpen: (leadId: string, tab: TabKey) => void
  onCallback: (leadId: string) => void
}) {
  return (
    // GHL click model: the card BODY opens the modal, the NAME navigates to
    // the full page. The trailing click is suppressed whenever dragstart
    // fired (aborted drags included), so body-click and drag coexist; the
    // selection guard below covers text-selection releases, which are NOT
    // drags. Keyboard path to the same modal: the "Open details" quick
    // action (focus-within reveals the row).
    <div
      draggable={lead.status !== "CONVERTED"}
      onDragStart={(e) => {
        if (lead.status === "CONVERTED") {
          e.preventDefault()
          return
        }
        e.dataTransfer.setData("leadId", lead.id)
      }}
      onClick={() => {
        // Releasing a text selection (copying the phone number) must not
        // open the modal.
        if (window.getSelection()?.toString()) return
        onOpen(lead.id, "details")
      }}
      className="group cursor-grab rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-3 transition-all hover:border-[var(--cf-border-strong)] active:cursor-grabbing"
    >
      <div className="mb-2 flex items-start justify-between">
        <div
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
          style={{ background: "linear-gradient(135deg, #4338CA 0%, #4F46E5 100%)" }}
        >
          {lead.firstName[0]}{lead.lastName[0]}
        </div>
        <div className="flex items-center gap-1.5">
          {(() => {
            const due = lead.callbackDate ? new Date(lead.callbackDate) : null
            const next = nextActionState(due)
            // Explicit timeZone on the tooltip date: without it this resolves
            // to the JS runtime's local zone, which differs between the server
            // (SSR, typically UTC) and the browser (SAST) — a text mismatch
            // that trips React hydration (#418).
            const when = due ? ` — ${due.toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}` : ""
            return (
              <span role="img" title={`${next.label}${when}`} aria-label={next.label} className="flex items-center gap-0.5">
                <CalendarClock className={cn("h-3 w-3", next.cls)} />
                {next.text && <span className={cn("text-[9px] font-bold uppercase", next.cls)}>{next.text}</span>}
              </span>
            )
          })()}
          <StalenessIndicator updatedAt={lead.updatedAt} />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Link
          href={`/crm/leads/${lead.id}`}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-[var(--cf-text)] transition-colors hover:text-[var(--cf-brand-soft)] hover:underline"
        >
          {lead.firstName} {lead.lastName}
        </Link>
        {/* Same person, worked twice. Links to the review page rather than
            asserting anything: the badge carries no evidence, so the claim it
            makes is only ever "worth a look". draggable={false} +
            stopPropagation for the same reason as the tel: link below — a
            native-draggable anchor hijacks the card drag, and the drop then
            reads an empty leadId and silently no-ops. */}
        {lead.duplicateCount > 0 && (
          <Link
            href={`/crm/leads/${lead.id}/duplicates`}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            title={`${lead.duplicateCount} other ${lead.duplicateCount === 1 ? "lead shares" : "leads share"} this phone number. Review — the page also matches on email, so it may list more.`}
            aria-label={`${lead.duplicateCount} possible duplicate ${lead.duplicateCount === 1 ? "lead" : "leads"} by phone — review, may list more`}
            className="flex flex-shrink-0 items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/12 px-1 py-0.5 text-[9px] font-bold text-amber-200 transition-colors hover:border-amber-400/70 hover:bg-amber-500/20"
          >
            <Copy className="h-2.5 w-2.5" />
            {lead.duplicateCount}
          </Link>
        )}
      </div>

      <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
        <Phone className="h-3 w-3" />
        {lead.phone}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 truncate">
          <span className="rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--cf-text-muted)]">
            {SOURCE_LABELS[lead.source] ?? lead.source}
          </span>
          <span className="whitespace-nowrap text-[10px] text-[var(--cf-text-muted)]" title="Days in current stage">
            {daysSince(lead.statusChangedAt)}d in stage
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          {lead.leadScore !== null && (() => {
            const t = SCORE_TIER(lead.leadScore)
            return (
              <span className={cn("rounded border px-1 py-0.5 text-[9px] font-bold", t.tone)}>
                {t.label}
              </span>
            )
          })()}
          <span className="text-[10px] text-[var(--cf-text-muted)]">{lead._count.activities} notes</span>
        </div>
      </div>

      {/* Quick actions — GHL-style hover row. focus-within keeps them reachable
          by keyboard; SMS is deliberately absent (BulkSMS still dry-run).
          stopPropagation: these must not ALSO fire the card body's
          open-details click. */}
      <div onClick={(e) => e.stopPropagation()} className="mt-2 flex items-center gap-0.5 border-t border-[var(--cf-border-subtle)] pt-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {/* First action = the keyboard path to what a body click does. */}
        <button type="button" title="Open details" aria-label="Open details" onClick={() => onOpen(lead.id, "details")} className={quickActionCls}>
          <User className="h-3.5 w-3.5" />
        </button>
        {/* draggable=false: an anchor is natively draggable and would hijack
            the card's drag when the gesture starts on this icon — the drop
            then reads an empty leadId and silently no-ops. */}
        <a href={`tel:${lead.phone}`} draggable={false} title="Call" aria-label={`Call ${lead.firstName}`} className={quickActionCls}>
          <Phone className="h-3.5 w-3.5" />
        </a>
        <button type="button" title="Outreach" aria-label="Open outreach" onClick={() => onOpen(lead.id, "outreach")} className={quickActionCls}>
          <MessageCircle className="h-3.5 w-3.5" />
        </button>
        <button type="button" title="Notes" aria-label="Open notes" onClick={() => onOpen(lead.id, "notes")} className={quickActionCls}>
          <StickyNote className="h-3.5 w-3.5" />
        </button>
        <button type="button" title="Tasks" aria-label="Open tasks" onClick={() => onOpen(lead.id, "tasks")} className={quickActionCls}>
          <ClipboardList className="h-3.5 w-3.5" />
        </button>
        {lead.status !== "CONVERTED" && lead.status !== "LOST" && (
          <button type="button" title="Schedule callback" aria-label="Schedule callback" onClick={() => onCallback(lead.id)} className={quickActionCls}>
            <CalendarClock className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
