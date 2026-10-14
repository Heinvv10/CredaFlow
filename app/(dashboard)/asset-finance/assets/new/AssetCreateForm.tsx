"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import type { AssetClass } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { ASSET_CLASS_LABELS } from "@/lib/asset-finance/asset-labels"
import { randsToCents } from "@/lib/asset-finance/money-input"

const TEXT_FIELDS = [
  ["make", "Make", true], ["model", "Model", true], ["serialNumber", "Serial number / PIN", true],
  ["vin", "VIN", false], ["engineNumber", "Engine number", false], ["registrationNumber", "Registration number", false],
  ["natisTitleholder", "eNaTIS titleholder", false], ["trackerProvider", "Tracker provider", false],
  ["trackerId", "Tracker unit ID", false], ["insurer", "Insurer", false], ["policyNumber", "Policy number", false],
] as const
const NUMBER_FIELDS = [["year", "Year", true], ["hours", "Hours", false], ["odometerKm", "Odometer (km)", false]] as const
const MONEY_FIELDS = [
  ["cashPriceExclVatCents", "Cash price excl. VAT (R)", true], ["vatCents", "VAT (R)", true], ["residualCents", "Residual (R)", false],
] as const

type Key = (typeof TEXT_FIELDS)[number][0] | (typeof NUMBER_FIELDS)[number][0] | (typeof MONEY_FIELDS)[number][0]

export function AssetCreateForm() {
  const router = useRouter()
  const [assetClass, setAssetClass] = useState<AssetClass>("EXCAVATOR")
  const [values, setValues] = useState<Partial<Record<Key, string>>>({})
  const [lenderNoted, setLenderNoted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const set = (key: Key) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }))

  const submit = async () => {
    const body: Record<string, unknown> = { assetClass, lenderNotedConfirmed: lenderNoted }
    const local: Record<string, string> = {}
    for (const [key] of TEXT_FIELDS) {
      const value = values[key]?.trim()
      if (value) body[key] = value
    }
    for (const [key] of NUMBER_FIELDS) {
      const value = values[key]?.trim()
      if (!value) continue
      if (!/^\d+$/.test(value)) local[key] = "must be a whole number"
      else body[key] = Number(value)
    }
    for (const [key] of MONEY_FIELDS) {
      const value = values[key]?.trim()
      if (!value) continue
      const cents = randsToCents(value)
      if (cents === null) local[key] = "must be an amount in rands, e.g. 1250000.00"
      else body[key] = cents
    }
    if (Object.keys(local).length > 0) {
      setFields(local)
      setError("Check the highlighted fields")
      return
    }
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson("/api/asset-finance/assets", "POST", body)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    const created = result.body as { id: string }
    router.push(`/asset-finance/assets/${created.id}`)
  }

  return (
    <DataPanel title="Asset details" density="loose">
      <div className="space-y-4">
        <FormError message={error} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <SelectField id="assetClass" label="Asset class" required value={assetClass} onChange={setAssetClass}
            options={ASSET_CLASS_LABELS} error={fields.assetClass} />
          {NUMBER_FIELDS.map(([key, label, required]) => (
            <TextField key={key} id={key} label={label} required={required} inputMode="numeric"
              value={values[key] ?? ""} onChange={set(key)} error={fields[key]} />
          ))}
          {TEXT_FIELDS.map(([key, label, required]) => (
            <TextField key={key} id={key} label={label} required={required}
              value={values[key] ?? ""} onChange={set(key)} error={fields[key]} />
          ))}
          {MONEY_FIELDS.map(([key, label, required]) => (
            <TextField key={key} id={key} label={label} required={required} inputMode="decimal"
              value={values[key] ?? ""} onChange={set(key)} error={fields[key]} />
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--cf-text)]">
          <input type="checkbox" checked={lenderNoted} onChange={(e) => setLenderNoted(e.target.checked)} />
          The insurer has noted the lender&apos;s interest on the policy
        </label>
        <div className="flex gap-2">
          <Button size="sm" onClick={submit} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {saving ? "Saving…" : "Register asset"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => router.push("/asset-finance/assets")}>Cancel</Button>
        </div>
      </div>
    </DataPanel>
  )
}
