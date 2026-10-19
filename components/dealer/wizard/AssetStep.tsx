"use client"

import { useState } from "react"
import type { AssetClass } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { ASSET_CLASS_LABELS } from "@/lib/asset-finance/asset-labels"
import { formatMoney } from "@/lib/asset-finance/format"
import { randsToCents } from "@/lib/asset-finance/money-input"
import { vatOnExclusive } from "@/lib/vat/amounts"

const TEXT = [
  ["make", "Make", true], ["model", "Model", true], ["serialNumber", "Serial number / PIN", true],
  ["vin", "VIN", false], ["engineNumber", "Engine number", false], ["registrationNumber", "Registration number", false],
] as const
type Key = (typeof TEXT)[number][0] | "year" | "price"

/**
 * Step 3: the asset — one the dealer registered before and is free to
 * finance, or a new one. VAT is the VAT on the exclusive price at the rate in
 * force today. A serial or VIN already financed and not released is refused.
 */
export function AssetStep({ assets, vatRateTenThousandths, onChosen }: {
  assets: { id: string; label: string }[]
  vatRateTenThousandths: number
  onChosen: (assetId: string) => void
}) {
  const [existing, setExisting] = useState("")
  const [assetClass, setAssetClass] = useState<AssetClass>("TLB")
  const [values, setValues] = useState<Partial<Record<Key, string>>>({})
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (key: Key) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }))
  const priceCents = values.price ? randsToCents(values.price) : null
  const vatCents = priceCents === null ? null : vatOnExclusive(priceCents, vatRateTenThousandths)

  async function next() {
    setError(null)
    setFields({})
    if (existing) return onChosen(existing)
    const local: Record<string, string> = {}
    if (!/^\d{4}$/.test(values.year?.trim() ?? "")) local.year = "A four-digit year"
    if (priceCents === null || priceCents <= 0) local.cashPriceExclVatCents = "An amount in rand, e.g. 1250000.00"
    if (Object.keys(local).length > 0) return setFields(local)
    const body: Record<string, unknown> = { assetClass, year: Number(values.year), cashPriceExclVatCents: priceCents, vatCents }
    for (const [key] of TEXT) if (values[key]?.trim()) body[key] = values[key]!.trim()
    setSaving(true)
    const result = await sendJson("/api/dealer/assets", "POST", body)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    onChosen((result.body as { id: string }).id)
  }

  return (
    <div className="space-y-4">
      <FormError message={error} />
      {assets.length > 0 ? (
        <SelectField id="existingAsset" label="An asset you registered before" value={existing} onChange={setExisting}
          options={Object.fromEntries([["", "No: register a new one"], ...assets.map((a) => [a.id, a.label])])} />
      ) : null}
      {existing ? null : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <SelectField id="assetClass" label="Asset class" required value={assetClass} onChange={setAssetClass} options={ASSET_CLASS_LABELS} error={fields.assetClass} />
          <TextField id="year" label="Year" required inputMode="numeric" value={values.year ?? ""} onChange={set("year")} error={fields.year} />
          {TEXT.map(([key, label, required]) => (
            <TextField key={key} id={key} label={label} required={required} value={values[key] ?? ""} onChange={set(key)} error={fields[key]} />
          ))}
          <TextField id="price" label="Cash price excl. VAT (R)" required inputMode="decimal" value={values.price ?? ""} onChange={set("price")} error={fields.cashPriceExclVatCents} />
          <div className="space-y-1.5 text-sm">
            <p className="text-xs text-[var(--cf-text-secondary)]">VAT at today&apos;s rate</p>
            <p className="py-2 tabular-nums text-[var(--cf-text)]">{vatCents === null ? "—" : formatMoney(vatCents)}</p>
            {fields.vatCents ? <p className="text-xs text-[var(--cf-danger)]">{fields.vatCents}</p> : null}
          </div>
        </div>
      )}
      <Button size="sm" onClick={next} disabled={saving}>{saving ? "Saving…" : existing ? "Continue" : "Register and continue"}</Button>
    </div>
  )
}
