"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { ASSET_READINESS_FIELDS, assetReadinessPatch, type AssetReadinessField } from "@/lib/asset-finance/asset-readiness"

const LABELS: Record<AssetReadinessField, string> = {
  natisTitleholder: "eNaTIS titleholder",
  trackerProvider: "Tracker provider",
  trackerId: "Tracker unit ID",
  insurer: "Insurer",
  policyNumber: "Policy number",
}

interface AssetReadinessFormProps {
  assetId: string
  initial: Record<AssetReadinessField, string | null> & { natisOwner: string | null; lenderNotedConfirmed: boolean }
}

export function AssetReadinessForm({ assetId, initial }: AssetReadinessFormProps) {
  const router = useRouter()
  const [values, setValues] = useState<Record<AssetReadinessField, string>>(
    Object.fromEntries(ASSET_READINESS_FIELDS.map((field) => [field, initial[field] ?? ""])) as Record<AssetReadinessField, string>,
  )
  const [natisOwner, setNatisOwner] = useState(initial.natisOwner ?? "")
  const [lenderNoted, setLenderNoted] = useState(initial.lenderNotedConfirmed)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})

  const save = async () => {
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson(
      `/api/asset-finance/assets/${assetId}`,
      "PATCH",
      assetReadinessPatch({ ...values, natisOwner }, lenderNoted),
    )
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    router.refresh()
  }

  return (
    <DataPanel title="Payout readiness" description="Record tracker, insurance and eNaTIS facts when they become available." density="loose">
      <div className="space-y-4">
        <FormError message={error} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {ASSET_READINESS_FIELDS.map((field) => (
            <TextField key={field} id={field} label={LABELS[field]} value={values[field]}
              onChange={(value) => setValues((current) => ({ ...current, [field]: value }))} error={fields[field]} />
          ))}
          <div className="space-y-1.5">
            <TextField id="natisOwner" label="eNaTIS owner" value={natisOwner} onChange={setNatisOwner} error={fields.natisOwner} />
            <p className="text-xs text-[var(--cf-text-muted)]">A leased vehicle&apos;s owner on eNaTIS must be the lender (checked at payout).</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--cf-text)]">
          <input type="checkbox" checked={lenderNoted} onChange={(event) => setLenderNoted(event.target.checked)} />
          The insurer has noted the lender&apos;s interest on the policy
        </label>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {saving ? "Saving…" : "Save payout facts"}
        </Button>
      </div>
    </DataPanel>
  )
}
