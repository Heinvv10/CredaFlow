"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { UserCog } from "lucide-react"
import { reassignLead } from "@/app/actions/crm"
import { resolveLeadOwner, type AssignableStaff } from "@/lib/crm/lead-assignment"

// Self-contained side-panel card: LeadDetailClient is already over the
// 300-line cap, so ownership lives here — chrome included — and the page
// mounts it with a single line.
export function LeadOwnerSelect({
  leadId,
  assignedToId,
  staff,
  canReassign,
}: {
  leadId: string
  assignedToId: string | null
  staff: AssignableStaff[]
  canReassign: boolean
}) {
  const router = useRouter()
  const [ownerId, setOwnerId] = useState<string>(assignedToId ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const owner = resolveLeadOwner(ownerId, staff)

  const handleChange = async (next: string) => {
    const previous = ownerId
    setError(null)
    setOwnerId(next)
    setSaving(true)
    try {
      const result = await reassignLead(leadId, next || null)
      if (!result.ok) {
        setOwnerId(previous)
        setError(result.error)
        return
      }
      router.refresh()
    } catch (err) {
      setOwnerId(previous)
      setError(err instanceof Error ? err.message : "Could not reassign this lead")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Owner</p>

      <div className="flex items-center gap-2 mb-3">
        <UserCog className={`h-4 w-4 flex-shrink-0 ${owner.state === "assigned" ? "text-gray-400" : "text-amber-500"}`} />
        <span
          className={`text-sm truncate ${owner.state === "assigned" ? "text-gray-700 font-medium" : "text-amber-600"}`}
          title={owner.label}
        >
          {owner.label}
        </span>
      </div>

      {!canReassign ? null : (
      <>
      <label htmlFor="lead-owner" className="sr-only">Assign this lead to</label>
      <select
        id="lead-owner"
        value={ownerId}
        disabled={saving}
        onChange={(e) => handleChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none focus:border-[#4338CA] disabled:opacity-60"
      >
        <option value="">Unassigned</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>{s.name ?? s.email}</option>
        ))}
        {/* A dangling owner has no staff row to select; keep it addressable so
            the control shows the real stored value instead of snapping to
            "Unassigned" and inviting a silent overwrite. */}
        {owner.state === "unknown" && <option value={ownerId}>{owner.label}</option>}
      </select>

      {saving && <p className="mt-2 text-xs text-gray-400">Saving…</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </>
      )}
    </div>
  )
}
