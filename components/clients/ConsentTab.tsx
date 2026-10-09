"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "@/lib/toast"
import { formatDateTime } from "@/lib/utils"

type Purposes = {
  creditBureauEnquiry: boolean
  insuranceUnderwriting: boolean
  smsMarketing: boolean
  emailMarketing: boolean
  thirdPartySharing: boolean
  automatedDecisionMaking: boolean
}

interface ConsentAuditRow {
  id: string
  action: "CONSENT_GRANTED" | "CONSENT_WITHDRAWN" | "CONSENT_PURPOSE_CHANGED"
  createdAt: Date
  actorName: string | null
  newValue: Record<string, unknown> | null
}

interface ConsentTabProps {
  clientId: string
  initial: Purposes & { capturedAt: Date | null; withdrawnAt: Date | null }
  recentAudit: ConsentAuditRow[]
}

const PROCESSING: Array<{ key: keyof Purposes; label: string }> = [
  { key: "creditBureauEnquiry", label: "Credit bureau enquiry" },
  { key: "insuranceUnderwriting", label: "Insurance underwriting" },
  { key: "thirdPartySharing", label: "Third-party sharing" },
  { key: "automatedDecisionMaking", label: "Automated decision-making" },
]

const MARKETING: Array<{ key: keyof Purposes; label: string }> = [
  { key: "smsMarketing", label: "SMS marketing" },
  { key: "emailMarketing", label: "Email marketing" },
]

export function ConsentTab({ clientId, initial, recentAudit }: ConsentTabProps) {
  const router = useRouter()
  const [state, setState] = useState<Purposes>({
    creditBureauEnquiry: initial.creditBureauEnquiry,
    insuranceUnderwriting: initial.insuranceUnderwriting,
    smsMarketing: initial.smsMarketing,
    emailMarketing: initial.emailMarketing,
    thirdPartySharing: initial.thirdPartySharing,
    automatedDecisionMaking: initial.automatedDecisionMaking,
  })
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  const processingDirty = PROCESSING.some(({ key }) => state[key] !== initial[key])
  const anyDirty =
    processingDirty || MARKETING.some(({ key }) => state[key] !== initial[key])
  const reasonValid = !processingDirty || reason.trim().length >= 8

  function set(key: keyof Purposes, v: boolean) {
    setState((s) => ({ ...s, [key]: v }))
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(`/api/clients/${clientId}/consent`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...state,
          ...(processingDirty ? { reason: reason.trim() } : {}),
        }),
      })
      if (res.ok) {
        toast.success("Consent updated", "Changes have been saved.")
        // Refresh server component data (audit footer) without a full HTML reload.
        router.refresh()
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error("Update failed", data.error ?? "Please try again later.")
      }
    } catch {
      toast.error("Network error", "Please check your connection.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Section
        title="Processing purposes"
        caption="Required for loan processing (NCA s.81, POPIA s.11). Changes require a reason for audit."
        items={PROCESSING}
        state={state}
        onChange={set}
      />

      <Section
        title="Marketing"
        caption="Separate from processing under POPIA s.69 — client must opt-in explicitly."
        items={MARKETING}
        state={state}
        onChange={set}
      />

      {processingDirty && (
        <div className="bg-white rounded-lg border border-amber-200 p-4">
          <label className="block text-xs text-amber-800 font-semibold mb-2">
            Reason (required, min 8 characters)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
            placeholder="e.g. Client phoned to revoke bureau consent on 2026-05-21"
          />
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !anyDirty || !reasonValid}
        className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
        style={{ backgroundColor: "#4338CA" }}
      >
        {saving ? "Saving..." : "Save consent changes"}
      </button>

      <AuditFooter rows={recentAudit} />
    </div>
  )
}

function Section({
  title,
  caption,
  items,
  state,
  onChange,
}: {
  title: string
  caption: string
  items: Array<{ key: keyof Purposes; label: string }>
  state: Purposes
  onChange: (key: keyof Purposes, v: boolean) => void
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <p className="text-xs text-gray-500 mt-1 mb-4">{caption}</p>
      <div className="space-y-2">
        {items.map(({ key, label }) => (
          <label key={key} className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-sm text-gray-700">{label}</span>
            <input
              type="checkbox"
              checked={state[key]}
              onChange={(e) => onChange(key, e.target.checked)}
              className="w-5 h-5 accent-amber-600 cursor-pointer"
            />
          </label>
        ))}
      </div>
    </div>
  )
}

function AuditFooter({ rows }: { rows: ConsentAuditRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="bg-gray-50 rounded-lg p-4">
        <p className="text-xs text-gray-500">No consent changes recorded yet.</p>
      </div>
    )
  }
  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
        Recent consent changes
      </h4>
      <ul className="space-y-2 text-xs">
        {rows.map((row) => (
          <li key={row.id} className="text-gray-700">
            <span className="font-medium">{formatDateTime(row.createdAt)}</span>
            {" · "}
            <span>{row.actorName ?? "—"}</span>
            {" · "}
            <span className="font-mono">{row.action}</span>
            {formatAuditValue(row.newValue)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatAuditValue(value: Record<string, unknown> | null): string {
  if (!value) return ""
  const parts: string[] = []
  for (const [key, v] of Object.entries(value)) {
    if (key === "reason" && typeof v === "string") continue // reason rendered separately below
    if (key === "purposes" && Array.isArray(v)) {
      parts.push(`${v.length} purpose${v.length === 1 ? "" : "s"}: ${v.join(", ")}`)
    } else if (typeof v === "boolean") {
      parts.push(`${key}: ${v}`)
    }
  }
  const reasonRaw = value.reason
  const reason = typeof reasonRaw === "string" ? reasonRaw : null
  if (reason) parts.push(`reason: ${reason}`)
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
}
