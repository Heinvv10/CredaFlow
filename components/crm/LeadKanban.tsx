"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LostReasonModal } from "@/components/crm/LostReasonModal"
import { CallbackModal } from "@/components/crm/CallbackModal"
import { LeadSlideOver } from "@/components/crm/LeadSlideOver"
import { SOURCE_LABELS, daysSince, leadNeedsAttention, type KanbanLead } from "@/components/crm/LeadCard"
import { COLUMNS, KanbanColumn } from "@/components/crm/KanbanColumn"
import { parseLeadModalParams, type TabKey } from "@/lib/crm/lead-modal-url"
import { leadPipelineStatus } from "@/lib/crm/lead-conversion"
import { useBoardAutoScroll } from "@/components/crm/useBoardAutoScroll"
import { cn } from "@/lib/utils"

type Lead = KanbanLead

// Mirror the open modal into ?lead=&tab= (GHL's modal is URL-addressable the
// same way). Shallow history calls — no RSC round-trip.
function modalUrl(next: { id: string; tab: TabKey } | null): string {
  const url = new URL(window.location.href)
  if (next) {
    url.searchParams.set("lead", next.id)
    url.searchParams.set("tab", next.tab)
  } else {
    url.searchParams.delete("lead")
    url.searchParams.delete("tab")
  }
  return url.toString()
}

export function LeadKanban({ initialLeads }: { initialLeads: Lead[] }) {
  const [leads, setLeads] = useState(initialLeads)
  const [dropError, setDropError] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState("ALL")
  const [staleOnly, setStaleOnly] = useState(false)
  const [needsAttention, setNeedsAttention] = useState(false)
  const [lostModalLeadId, setLostModalLeadId] = useState<string | null>(null)
  const [callbackLeadId, setCallbackLeadId] = useState<string | null>(null)
  const router = useRouter()
  // Destructured, not held as one `board` object: react-hooks/refs treats a
  // property read on a hook return that touches refs as a ref access during
  // render, and fails the lint on every `board.onDragOver` in the JSX below.
  const {
    setBoard,
    edges: boardEdges,
    onDragOver: onBoardDragOver,
    onScroll: onBoardScroll,
    onDrop: onBoardDrop,
    onDragEnd: onBoardDragEnd,
  } = useBoardAutoScroll()

  // The URL is the single source of truth for the open modal — Next keeps
  // useSearchParams in sync with pushState/replaceState AND popstate, so
  // deep-links, soft navigations, and back/forward all just work. Opening
  // PUSHES an entry (Back closes the modal); close/tab-switch REPLACE (a
  // deep-link landing has no in-app entry to pop to).
  const searchParams = useSearchParams()
  const openLead = parseLeadModalParams(
    searchParams.get("lead") ?? undefined,
    searchParams.get("tab") ?? undefined
  )

  const openModal = (id: string, tab: TabKey) =>
    window.history.pushState(null, "", modalUrl({ id, tab }))
  const closeModal = () => {
    window.history.replaceState(null, "", modalUrl(null))
    router.refresh()
  }

  const filteredLeads = leads.filter((lead) => {
    if (sourceFilter !== "ALL" && lead.source !== sourceFilter) return false
    if (staleOnly && daysSince(lead.updatedAt) <= 3) return false
    if (needsAttention && !leadNeedsAttention(lead)) return false
    return true
  })

  const pipelineStatus = (lead: Lead) => leadPipelineStatus(
    lead.status,
    lead.convertedToClientId,
    lead.convertedToApplicationId,
    lead.conversionRecoveryRequired,
  )

  const handleDrop = async (leadId: string, newStatus: string) => {
    const lead = leads.find((item) => item.id === leadId)
    if (!lead || lead.status === newStatus) return

    if (newStatus === "CONVERTED") {
      router.push(`/crm/leads/${leadId}/convert`)
      return
    }

    if (newStatus === "LOST") {
      setLostModalLeadId(leadId)
      return
    }

    setDropError(null)
    setLeads((prev) => prev.map((item) => item.id === leadId ? { ...item, status: newStatus } : item))

    try {
      const res = await fetch(`/api/crm/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      })

      if (!res.ok) {
        setLeads((prev) => prev.map((item) => item.id === leadId ? { ...item, status: lead.status } : item))
        const body = await res.json().catch(() => null) as { error?: string } | null
        setDropError(body?.error ?? "Failed to update lead status - please try again")
        return
      }

      router.refresh()
    } catch {
      setLeads((prev) => prev.map((item) => item.id === leadId ? { ...item, status: lead.status } : item))
      setDropError("Network error - please try again")
    }
  }

  const sources = Array.from(new Set(leads.map((lead) => lead.source))).sort()

  return (
    <div className="min-w-0 space-y-5">
      {lostModalLeadId && (
        <LostReasonModal
          leadId={lostModalLeadId}
          onClose={() => { setLostModalLeadId(null); router.refresh() }}
        />
      )}

      <LeadSlideOver
        leadId={openLead?.id ?? null}
        initialTab={openLead?.tab}
        onTabChange={(tab) => {
          if (openLead) window.history.replaceState(null, "", modalUrl({ id: openLead.id, tab }))
        }}
        // Refresh the board on close so a stage move / task made inside the
        // slide-over is reflected on the cards behind it. URL is stripped
        // FIRST so the refresh re-renders the clean address.
        onClose={closeModal}
      />
      {callbackLeadId && (
        <CallbackModal
          leadId={callbackLeadId}
          onClose={() => { setCallbackLeadId(null); router.refresh() }}
        />
      )}
      {dropError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/12 px-4 py-2 text-sm text-red-200">{dropError}</div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">
            CRM Pipeline
          </p>
          <h1 className="text-2xl font-semibold text-[var(--cf-text)]">Leads Pipeline</h1>
          <p className="mt-1 text-sm text-[var(--cf-text-muted)]">
            {filteredLeads.length === leads.length
              ? `${leads.length} total leads`
              : `${filteredLeads.length} of ${leads.length} leads`}{" "}
            · drag cards to move stages
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/crm/leads/queue"
            className="rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-3 py-1.5 text-sm text-[var(--cf-text-secondary)] transition-colors hover:border-[var(--cf-border-strong)]"
          >
            Work queue →
          </Link>
          <Button asChild>
            <Link href="/crm/leads/new">
              <Plus className="h-4 w-4" />
              Add Lead
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2.5 py-1.5 text-sm text-[var(--cf-text-secondary)] outline-none focus:border-[var(--cf-border-strong)] focus:ring-2 focus:ring-[rgba(79,70,229,0.22)]"
        >
          <option value="ALL">All sources</option>
          {sources.map((source) => (
            <option key={source} value={source}>{SOURCE_LABELS[source] ?? source}</option>
          ))}
        </select>

        <button
          onClick={() => setStaleOnly((value) => !value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
            staleOnly
              ? "border-red-500/40 bg-red-500/12 font-medium text-red-200"
              : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] text-[var(--cf-text-muted)] hover:border-[var(--cf-border-strong)]"
          )}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
          Stale only
        </button>

        <button
          onClick={() => setNeedsAttention((value) => !value)}
          title="Open leads with an overdue callback, gone stale, or unassigned"
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
            needsAttention
              ? "border-amber-500/40 bg-amber-500/12 font-medium text-amber-200"
              : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] text-[var(--cf-text-muted)] hover:border-[var(--cf-border-strong)]"
          )}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
          Needs attention
        </button>

        {(sourceFilter !== "ALL" || staleOnly || needsAttention) && (
          <button
            onClick={() => { setSourceFilter("ALL"); setStaleOnly(false); setNeedsAttention(false) }}
            className="text-sm text-[var(--cf-text-muted)] underline hover:text-[var(--cf-text-secondary)]"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* One scrolling row, not a wrapping grid. The grid put four columns per
          row at xl, which silently pushed Incomplete/Stranded/Converted/Lost
          onto a second row below the fold — so the board showed 8 of 43 leads
          and read as data loss. Fades mark that there is more board; without
          them this is the same invisibility in a new costume, because Chrome's
          overlay scrollbars disappear when idle. */}
      <div className="relative">
        <div
          ref={setBoard}
          onScroll={onBoardScroll}
          onDragOver={onBoardDragOver}
          onDrop={onBoardDrop}
          onDragEnd={onBoardDragEnd}
          className="flex gap-3 overflow-x-auto pb-3 [scrollbar-color:var(--cf-border-strong)_transparent] [scrollbar-width:thin]"
        >
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col.status}
              col={col}
              leads={filteredLeads.filter((lead) => pipelineStatus(lead) === col.status)}
              onDrop={handleDrop}
              onOpen={openModal}
              onCallback={setCallbackLeadId}
            />
          ))}
        </div>
        {boardEdges.left && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[var(--cf-bg)] to-transparent" />
        )}
        {boardEdges.right && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--cf-bg)] to-transparent" />
        )}
      </div>
    </div>
  )
}
