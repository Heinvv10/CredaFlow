"use client"

import { useState } from "react"
import { Pin, PinOff } from "lucide-react"
import { ActivityRow, MessageRow } from "@/components/crm/LeadTimelineRow"
import { mergeLeadTimeline, type LeadTimelineEntry, type TimelineMessageInput } from "@/lib/crm/lead-timeline"
import { toggleLeadActivityPinned } from "@/app/actions/lead-activities"

// Client component: prisma-free imports only (toggleLeadActivityPinned is a
// server-action RPC stub). The merged activity + comms timeline with
// Close/HubSpot-style type filter chips and pin-to-top.

type ActivityInput = { id: string; type: string; subject: string; notes: string | null; pinned: boolean; createdAt: string }

const CHIPS = [
  { key: "all", label: "All" },
  { key: "NOTE", label: "Notes" },
  { key: "CALL", label: "Calls" },
  { key: "EMAIL", label: "Email" },
  { key: "WHATSAPP", label: "WhatsApp" },
  { key: "SMS", label: "SMS" },
] as const
type ChipKey = (typeof CHIPS)[number]["key"]

// An activity matches on its type; a comms message matches on its channel.
function matchesChip(entry: LeadTimelineEntry, chip: ChipKey): boolean {
  if (chip === "all") return true
  return entry.kind === "activity" ? entry.type === chip : entry.channel === chip
}

export function LeadActivityTab({
  activities,
  commsMessages,
  onChanged,
}: {
  activities: ActivityInput[]
  commsMessages: TimelineMessageInput[]
  onChanged: () => void
}) {
  const [chip, setChip] = useState<ChipKey>("all")
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pinnedById = new Map(activities.map((a) => [a.id, a.pinned]))
  const timeline = mergeLeadTimeline(
    activities.map((a) => ({ ...a, createdAt: new Date(a.createdAt) })),
    commsMessages,
  ).filter((e) => matchesChip(e, chip))
  const pinned = timeline.filter((e) => e.kind === "activity" && pinnedById.get(e.id))
  const rest = timeline.filter((e) => !(e.kind === "activity" && pinnedById.get(e.id)))

  const togglePin = async (id: string, pin: boolean) => {
    if (busyId) return
    setBusyId(id)
    setError(null)
    try {
      const result = await toggleLeadActivityPinned(id, pin)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onChanged()
    } catch {
      setError("Could not update the pin. Reload and try again.")
    } finally {
      setBusyId(null)
    }
  }

  const renderEntry = (entry: LeadTimelineEntry) =>
    entry.kind === "activity" ? (
      <div key={`a-${entry.id}`} className="group relative">
        <ActivityRow entry={entry} />
        <button
          type="button"
          onClick={() => void togglePin(entry.id, !pinnedById.get(entry.id))}
          disabled={busyId !== null}
          title={pinnedById.get(entry.id) ? "Unpin" : "Pin to top"}
          aria-label={pinnedById.get(entry.id) ? "Unpin" : "Pin to top"}
          className="absolute right-2 top-2 rounded p-1 text-gray-300 opacity-0 transition-opacity hover:bg-gray-100 hover:text-amber-600 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
        >
          {pinnedById.get(entry.id) ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
      </div>
    ) : (
      <MessageRow key={`m-${entry.id}`} entry={entry} />
    )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            onClick={() => setChip(c.key)}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              chip === c.key
                ? "border-amber-600 bg-amber-50 font-medium text-amber-700"
                : "border-gray-200 text-gray-500 hover:border-gray-300"
            }`}
          >
            {c.label}
          </button>
        ))}
        {error && <span className="ml-auto text-xs text-red-600">{error}</span>}
      </div>

      {pinned.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40">
          <p className="flex items-center gap-1 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
            <Pin className="h-3 w-3" /> Pinned
          </p>
          {pinned.map(renderEntry)}
        </div>
      )}

      {rest.length === 0 && pinned.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">
          {chip === "all" ? "No activity yet." : "Nothing matches this filter."}
        </p>
      ) : (
        <div className="space-y-2">{rest.map(renderEntry)}</div>
      )}
    </div>
  )
}
