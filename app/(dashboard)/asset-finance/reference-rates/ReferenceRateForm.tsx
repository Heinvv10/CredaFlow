"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { percentToDecimal } from "@/lib/asset-finance/deal-labels"

type Basis = "PRIME" | "REPO" | "JIBAR" | "ZARONIA" | "LENDER_BASE"
const BASES: Record<Basis, string> = {
  PRIME: "Prime", REPO: "Repo", JIBAR: "JIBAR", ZARONIA: "ZARONIA", LENDER_BASE: "Lender base rate",
}

/**
 * Records a reference-rate value (decide_asset_finance). It is PENDING until a
 * different user approves it; only then does the repricing cron apply it.
 */
export function ReferenceRateForm() {
  const router = useRouter()
  const [basis, setBasis] = useState<Basis>("PRIME")
  const [effectiveDate, setEffectiveDate] = useState("")
  const [percent, setPercent] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const rate = percentToDecimal(percent, false)
    if (rate === null) {
      setFields({ rate: "Enter the annual rate as a percentage, e.g. 11.75" })
      return
    }
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson("/api/asset-finance/reference-rates", "POST", { basis, effectiveDate, rate })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    setEffectiveDate("")
    setPercent("")
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SelectField id="basis" label="Basis" required value={basis} onChange={setBasis} options={BASES} error={fields.basis} />
        <TextField id="effectiveDate" label="Effective from" type="date" required value={effectiveDate} onChange={setEffectiveDate} error={fields.effectiveDate} />
        <TextField id="rate" label="Annual rate (%)" inputMode="decimal" required placeholder="11.75" value={percent} onChange={setPercent} error={fields.rate} />
      </div>
      <p className="text-xs text-[var(--cf-text-muted)]">
        The value is recorded as pending. A different user with the decide permission must approve it before any loan reprices on it.
      </p>
      <Button size="sm" onClick={submit} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {saving ? "Recording…" : "Record rate"}
      </Button>
    </div>
  )
}
