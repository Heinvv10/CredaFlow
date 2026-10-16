"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Bell } from "lucide-react"
import { formatDateTime } from "@/lib/utils"

// Takes its data from /api/notifications — it must NOT import
// lib/notifications/bell.ts, which pulls in prisma and would bundle server
// code for the browser (only `npm run build` catches that).

type BellItem = {
  id: string
  type: string
  title: string
  body: string | null
  entityType: string | null
  entityId: string | null
  readAt: string | null
  createdAt: string
}

/** How often the bell re-checks. Long enough to be cheap (one indexed count
 *  per staff tab), short enough that a due-task reminder shows up while the
 *  agent is still on the phone. */
const POLL_MS = 60_000

function hrefFor(item: BellItem): string | null {
  if (item.entityType === "Lead" && item.entityId) return `/crm/leads/${item.entityId}`
  // Two entity types for a note mention, on purpose: any active staffer is
  // mentionable, but only a comms agent can open /inbox. The client page is
  // reachable by every staff role, so the fan-out picks Client whenever the
  // thread has one and falls back to Conversation only when it does not.
  if (item.entityType === "Client" && item.entityId) return `/clients/${item.entityId}?tab=comms`
  if (item.entityType === "Conversation" && item.entityId) return `/inbox?conversationId=${item.entityId}`
  if (item.entityType === "BureauSubmission") return "/compliance/bureau-submissions"
  return null
}

export function NotificationBell() {
  const router = useRouter()
  const [items, setItems] = useState<BellItem[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const res = await fetch("/api/notifications")
        if (!res.ok) return
        const data = (await res.json()) as { items: BellItem[]; unread: number }
        if (cancelled) return
        setItems(data.items)
        setUnread(data.unread)
      } catch {
        // A failed poll is not worth surfacing — the next tick retries and the
        // bell simply shows its last known state.
      }
    }

    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Close on an outside click, so the panel does not sit over the page.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  const markAllRead = async () => {
    // Optimistic: the badge is the whole point of the control, so it should
    // clear on click rather than a poll later. A failed POST is corrected by
    // the next poll.
    setUnread(0)
    setItems((prev) => prev.map((i) => (i.readAt ? i : { ...i, readAt: new Date().toISOString() })))
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    } catch {
      // Swallowed deliberately — the next poll restores the true count.
    }
  }

  const openItem = async (item: BellItem) => {
    const href = hrefFor(item)
    if (!item.readAt) {
      setUnread((u) => Math.max(0, u - 1))
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)))
      fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [item.id] }),
      }).catch(() => {})
    }
    setOpen(false)
    if (href) router.push(href)
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)] transition-colors hover:text-[var(--cf-brand-soft)]"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#4338CA] px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--cf-border-subtle)] px-4 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">
              Notifications
            </p>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-[11px] font-medium text-[var(--cf-brand-soft)] hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 && (
              <p className="px-4 py-8 text-center text-xs text-[var(--cf-text-muted)]">Nothing new</p>
            )}
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => openItem(item)}
                className={`flex w-full flex-col items-start gap-0.5 border-b border-[var(--cf-border-subtle)] px-4 py-3 text-left transition-colors hover:bg-[rgba(79,70,229,0.10)] ${
                  item.readAt ? "opacity-60" : ""
                }`}
              >
                <div className="flex w-full items-start gap-2">
                  {!item.readAt && <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#4338CA]" />}
                  <p className="text-xs font-semibold text-[var(--cf-text-secondary)]">{item.title}</p>
                </div>
                {item.body && <p className="pl-3.5 text-[11px] text-[var(--cf-text-muted)]">{item.body}</p>}
                <p className="pl-3.5 text-[10px] text-[var(--cf-text-muted)]">{formatDateTime(item.createdAt)}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
