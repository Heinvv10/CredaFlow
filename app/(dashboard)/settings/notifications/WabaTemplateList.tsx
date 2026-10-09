"use client"

import type { WabaTemplate } from "./WabaTemplateEditor"

/**
 * Every template and its Meta status, visible at once.
 *
 * This replaces a <select>. With nine rows behind a dropdown, the only way to
 * answer "which are approved, which are still pending, which were never
 * submitted" was to select each in turn and read the badge — and Meta approval
 * is asynchronous (poll-wa-templates every 15 min, plus the
 * message_template_status_update webhook), so that question gets asked
 * repeatedly over hours.
 */

export type Summary = {
  approved: number
  pending: number
  rejected: number
  notSubmitted: number
  total: number
}

export function summarise(rows: WabaTemplate[]): Summary {
  const s: Summary = { approved: 0, pending: 0, rejected: 0, notSubmitted: 0, total: rows.length }
  for (const r of rows) {
    if (r.providerStatus === "APPROVED") s.approved++
    else if (r.providerStatus === "REJECTED") s.rejected++
    else if (r.providerStatus) s.pending++
    else s.notSubmitted++
  }
  return s
}

function tone(status: string | null): string {
  return status === "APPROVED" ? "bg-green-100 text-green-700"
    : status === "REJECTED" ? "bg-red-100 text-red-700"
      : status ? "bg-amber-100 text-amber-700"
        : "bg-gray-100 text-gray-500"
}

export function WabaTemplateList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: WabaTemplate[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const s = summarise(rows)
  // Only the counts that apply. "0 rejected" is noise on a healthy account,
  // and a zero next to "rejected" reads as an alert that isn't one.
  const parts = [
    s.approved > 0 ? `${s.approved} approved` : null,
    s.pending > 0 ? `${s.pending} pending` : null,
    s.rejected > 0 ? `${s.rejected} rejected` : null,
    s.notSubmitted > 0 ? `${s.notSubmitted} not submitted` : null,
  ].filter(Boolean)

  return (
    <div className="bg-white rounded-lg border border-[#e5e7eb] p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold text-[#1b1d24]">WhatsApp templates</h3>
        <p className="text-xs text-gray-500">{parts.join(" · ")}</p>
      </div>

      <ul className="divide-y divide-[#e5e7eb] border border-[#e5e7eb] rounded-md overflow-hidden">
        {rows.map((r) => {
          const isSelected = r.id === selectedId
          // A row with no body cannot be submitted at all — distinct from one
          // that simply hasn't been yet. Without the distinction an operator
          // hunts for a Save that will never succeed.
          const noBody = !r.bodyTemplate || r.bodyTemplate.trim() === ""
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-current={isSelected ? "true" : undefined}
                // bg-gray-50, NOT an arbitrary hex: app/globals.css remaps the
                // literal class to a dark token, and an arbitrary value slips
                // past that remap — leaving a light row under light text.
                className={`w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-gray-50 ${
                  isSelected ? "bg-gray-50 border-l-2 border-l-amber-600" : "border-l-2 border-l-transparent"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs text-[#1b1d24] truncate">{r.event}</span>
                  <span className="block text-[11px] text-gray-400 truncate">
                    {r.wabaTemplateName ?? (noBody ? "no body yet — cannot be submitted" : "not named yet")}
                  </span>
                </span>
                {!r.active && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-500">
                    INACTIVE
                  </span>
                )}
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${tone(r.providerStatus)}`}>
                  {r.providerStatus ?? "NOT SUBMITTED"}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-current={selectedId === null ? "true" : undefined}
        className={`text-xs text-amber-700 hover:underline ${selectedId === null ? "font-semibold" : ""}`}
      >
        + New template
      </button>

      {s.pending > 0 && (
        <p className="text-[11px] text-gray-400">
          Pending templates are checked against Meta every 15 minutes, and updated immediately if Meta
          sends a status webhook. Nothing further is needed here.
        </p>
      )}
    </div>
  )
}
