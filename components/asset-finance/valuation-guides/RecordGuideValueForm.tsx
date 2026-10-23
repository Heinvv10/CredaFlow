"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"
import { SELECT_CLASS } from "@/components/asset-finance/form-fields"

export interface GuideChoice { guideRowId: string; label: string }

/** Records the chosen current guide row as the asset's GUIDE valuation (today, at its trade value). */
export function RecordGuideValueForm({ assetId, choices }: { assetId: string; choices: GuideChoice[] }) {
  const router = useRouter()
  const [rowId, setRowId] = useState(choices.length === 1 ? choices[0].guideRowId : "")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const record = async () => {
    if (!rowId) {
      setError("Choose the guide row that matches the asset's variant")
      return
    }
    setSaving(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/assets/${assetId}/guide-valuations`, "POST", { guideRowId: rowId })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <FormError message={error} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor={`guide-row-${assetId}`} className="mb-1.5 block text-xs text-[var(--cf-text-secondary)]">Guide row (variant)</label>
          <select id={`guide-row-${assetId}`} className={SELECT_CLASS} value={rowId} onChange={(e) => setRowId(e.target.value)}>
            {choices.length > 1 && <option value="">Choose…</option>}
            {choices.map((c) => <option key={c.guideRowId} value={c.guideRowId}>{c.label}</option>)}
          </select>
        </div>
        <Button size="sm" onClick={record} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {saving ? "Recording…" : "Record guide value"}
        </Button>
      </div>
    </div>
  )
}
