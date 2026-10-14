"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/lib/utils"
import { ENTITY_DOCUMENT_LABELS } from "@/lib/asset-finance/labels"
import type { EntityDocumentView } from "@/lib/asset-finance/entity-documents"

/**
 * Choose which verified AFS / management accounts evidence the entity's
 * turnover and asset value. The server re-checks every id
 * (PUT …/financials-evidence); this list only offers the eligible ones.
 */
export function FinancialsEvidencePanel({
  entityId,
  hasFigures,
  eligible,
  selectedIds,
  canManage,
}: {
  entityId: string
  hasFigures: boolean
  eligible: EntityDocumentView[]
  selectedIds: string[]
  canManage: boolean
}) {
  const router = useRouter()
  const [chosen, setChosen] = useState(() => new Set(selectedIds))
  const [saving, setSaving] = useState(false)
  const dirty = chosen.size !== selectedIds.length || selectedIds.some((id) => !chosen.has(id))

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/asset-finance/entities/${entityId}/financials-evidence`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: [...chosen] }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        toast.error(body.error ?? "Could not save the evidence")
        return
      }
      toast.success("Financials evidence saved")
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DataPanel
      title="Financials evidence"
      description="The NCA classifier treats the turnover and asset value as proven only when verified financial statements are attached here."
      density="compact"
    >
      {!hasFigures ? (
        <p className="text-sm text-[var(--cf-text-muted)]">Record a turnover or asset value and its financial year first.</p>
      ) : eligible.length === 0 ? (
        <p className="text-sm text-[var(--cf-text-muted)]">
          Upload and verify the annual financial statements or management accounts to attach them.
        </p>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2">
            {eligible.map((d) => (
              <li key={d.id}>
                <label className="flex items-center gap-3 text-sm text-[var(--cf-text)]">
                  <input
                    type="checkbox"
                    checked={chosen.has(d.id)}
                    disabled={!canManage}
                    onChange={() => toggle(d.id)}
                    className="h-4 w-4 accent-[var(--cf-brand)]"
                  />
                  <span>
                    {ENTITY_DOCUMENT_LABELS[d.docType]} — {d.fileName}
                    <span className="text-xs text-[var(--cf-text-muted)]"> (verified {d.verifiedAt ? formatDate(d.verifiedAt) : ""})</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {canManage && (
            <Button type="button" size="sm" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save evidence"}
            </Button>
          )}
        </div>
      )}
    </DataPanel>
  )
}
