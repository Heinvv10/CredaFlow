"use client"

import Link from "next/link"
import { ExternalLink, Loader2 } from "lucide-react"

// Client component: prisma-free imports only. The lead modal's footer —
// created line + full-page escape hatch left, Save/Cancel right (GHL layout).
// Extracted from LeadSlideOver for the 300-line cap.

export function LeadModalFooter({
  lead,
  canEdit,
  dirty,
  saving,
  saveError,
  onCancel,
  onSave,
}: {
  lead: { id: string; createdAt: string }
  canEdit: boolean
  dirty: boolean
  saving: boolean
  saveError: string | null
  onCancel: () => void
  onSave: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-6 py-3">
      <div className="min-w-0 text-xs text-gray-500">
        <span>Created {new Date(lead.createdAt).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })}</span>
        {" · "}
        <Link href={`/crm/leads/${lead.id}`} className="inline-flex items-center gap-1 font-medium text-amber-700 hover:text-amber-800">
          Open full page <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      <div className="flex items-center gap-2">
        {saveError && <span className="mr-1 text-xs text-red-600">{saveError}</span>}
        <button onClick={onCancel} className="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
        {canEdit && (
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        )}
      </div>
    </div>
  )
}
