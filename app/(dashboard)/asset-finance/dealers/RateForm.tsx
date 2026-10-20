"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { randsToCents } from "@/lib/asset-finance/money-input"

/**
 * A commission rate from a date: a percentage of the goods advance (the
 * asset's cash price incl. VAT less deposit and trade-in; never the financed
 * fees or interest) plus a flat amount, both ex VAT. A dealer's own rate (url …/dealers/[id]/rates)
 * or the lender's default (…/dealer-commission/default-rate). Never edited:
 * a change is a new row from a new date.
 */
export function RateForm({ url, label }: { url: string; label: string }) {
  const router = useRouter()
  const [effectiveFrom, setEffectiveFrom] = useState("")
  const [percent, setPercent] = useState("")
  const [flat, setFlat] = useState("0")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const bps = Math.round(Number(percent) * 100)
    const flatCents = randsToCents(flat)
    if (percent.trim() === "" || !Number.isFinite(bps)) return setFields({ bps: "Enter a percentage, e.g. 2.5" })
    if (flatCents === null) return setFields({ flatCents: "Enter an amount in rand, e.g. 1500" })
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson(url, "POST", { effectiveFrom, bps, flatCents })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    setEffectiveFrom(""); setPercent(""); setFlat("0")
    router.refresh()
  }

  return (
    <div className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] p-4">
      <h3 className="text-sm font-semibold text-[var(--cf-text)]">{label}</h3>
      <p className="text-xs text-[var(--cf-text-muted)]">
        Commission is the lender&apos;s cost, never a charge to the borrower. A deal takes the rate in force on the day it is approved.
      </p>
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <TextField id={`${url}-from`} label="Effective from" type="date" required value={effectiveFrom} onChange={setEffectiveFrom} error={fields.effectiveFrom} />
        <TextField id={`${url}-pct`} label="Percentage of the goods advance (%)" inputMode="decimal" required value={percent} onChange={setPercent} error={fields.bps} />
        <TextField id={`${url}-flat`} label="Plus a flat amount (R, ex VAT)" inputMode="decimal" value={flat} onChange={setFlat} error={fields.flatCents} />
      </div>
      <Button size="sm" onClick={submit} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        Add rate
      </Button>
    </div>
  )
}
