"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { LeadCard, type KanbanLead } from "@/components/crm/LeadCard"
import type { TabKey } from "@/lib/crm/lead-modal-url"
import { cn, formatZARCompact } from "@/lib/utils"

// One stage column of the leads pipeline. Split out of LeadKanban.tsx for the
// same reason LeadCard was — the board file was back over the 300-line cap
// once it grew the scroll container and its drag-autoscroll wiring.

/** The stages the board renders. NOT `LeadStatus`: `INCOMPLETE` and `STRANDED`
 *  are derived presentation states from leadPipelineStatus(), and `recovery`
 *  marks them undroppable — a lead gets out of them by being fixed, not by
 *  being dragged. */
export const COLUMNS = [
  { status: "NEW", label: "New" },
  { status: "CONTACTED", label: "Contacted" },
  { status: "QUALIFIED", label: "Qualified" },
  { status: "PROPOSAL_SENT", label: "Proposal Sent" },
  { status: "INCOMPLETE", label: "Incomplete", recovery: true },
  { status: "STRANDED", label: "Stranded", recovery: true },
  { status: "CONVERTED", label: "Converted" },
  { status: "LOST", label: "Lost" },
]

export type KanbanColumnSpec = (typeof COLUMNS)[0]

export function KanbanColumn({
  col,
  leads,
  onDrop,
  onOpen,
  onCallback,
}: {
  col: KanbanColumnSpec
  leads: KanbanLead[]
  onDrop: (leadId: string, status: string) => void
  onOpen: (leadId: string, tab: TabKey) => void
  /** Absent when the viewer may not schedule callbacks: the card hides the button. */
  onCallback?: (leadId: string) => void
}) {
  const [dragOver, setDragOver] = useState(false)

  return (
    <div
      className={cn(
        // Fixed width + shrink-0: the board is a scrolling row now, so a
        // column must keep its size rather than compressing to fit. Eight
        // columns compressed into one viewport is what made cards unreadable
        // and pushed half the pipeline onto an invisible second row.
        "flex w-[264px] flex-shrink-0 flex-col rounded-lg border transition-colors sm:w-[280px]",
        dragOver
          ? "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.12)]"
          : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]"
      )}
      onDragOver={(e) => {
        if (col.recovery) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (col.recovery) return
        e.preventDefault()
        setDragOver(false)
        onDrop(e.dataTransfer.getData("leadId"), col.status)
      }}
    >
      <div className="flex items-center justify-between border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--cf-text-secondary)]">
            {col.label}
          </span>
          <Badge className="min-w-[20px] justify-center px-1.5 py-0.5 text-[10px]">{leads.length}</Badge>
        </div>
        {/* GHL-style stage economics: summed requested amount of the cards
            below (cents in, compact rand out). The tooltip says "in this
            stage", not "visible" — the column has its own vertical scroll, so
            the sum routinely covers cards that are off-screen, and the old
            wording invited staff to reconcile it against what they could see
            and conclude the total was wrong. */}
        <span className="text-[10px] font-medium tabular-nums text-[var(--cf-text-muted)]" title="Total requested amount of every card in this stage, including any scrolled out of view">
          {formatZARCompact(leads.reduce((sum, lead) => sum + (lead.requestedAmount ?? 0), 0))}
        </span>
      </div>

      <div className="max-h-[calc(100vh-280px)] min-h-[240px] flex-1 space-y-2 overflow-y-auto p-2">
        {leads.map((lead) => (
          <LeadCard key={lead.id} lead={lead} onOpen={onOpen} onCallback={onCallback} />
        ))}
      </div>
    </div>
  )
}
