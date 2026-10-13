"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { BusinessEntityType } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { FormSection } from "@/components/app-shell/FormSection"
import { ENTITY_TYPE_LABELS } from "@/lib/asset-finance/labels"
import { SelectField, TextField, centsToRandsInput, randsToCents } from "./form-fields"

export interface EntityFormValues {
  type: BusinessEntityType | ""
  legalName: string
  tradingName: string
  registrationNumber: string
  vatNumber: string
  annualTurnover: number | null
  totalAssetValue: number | null
  financialYearEnd: string
  addressLine1: string
  addressLine2: string
  city: string
  province: string
  postalCode: string
}

export const EMPTY_ENTITY_FORM: EntityFormValues = {
  type: "",
  legalName: "",
  tradingName: "",
  registrationNumber: "",
  vatNumber: "",
  annualTurnover: null,
  totalAssetValue: null,
  financialYearEnd: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  province: "",
  postalCode: "",
}

const TYPE_OPTIONS = (Object.keys(ENTITY_TYPE_LABELS) as BusinessEntityType[]).map((value) => ({
  value,
  label: ENTITY_TYPE_LABELS[value],
}))

const REGISTRATION_HINT: Record<BusinessEntityType, string> = {
  COMPANY: "CIPC number, e.g. 2015/123456/07",
  CC: "CIPC number, e.g. 1998/012345/23",
  TRUST: "Master's reference, e.g. IT1234/2015",
  PARTNERSHIP: "The partnership's own reference",
}

/** Create (no entityId) or edit an entity. Edit cannot change the type. */
export function EntityForm({ entityId, initial }: { entityId?: string; initial: EntityFormValues }) {
  const router = useRouter()
  const [values, setValues] = useState(initial)
  const [turnover, setTurnover] = useState(centsToRandsInput(initial.annualTurnover))
  const [assets, setAssets] = useState(centsToRandsInput(initial.totalAssetValue))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const set = (key: keyof EntityFormValues) => (value: string) => setValues((v) => ({ ...v, [key]: value }))

  async function submit() {
    const turnoverCents = randsToCents(turnover)
    const assetsCents = randsToCents(assets)
    const local: Record<string, string> = {}
    if (turnoverCents === undefined) local.annualTurnover = "An amount in rand, e.g. 1500000.00"
    if (assetsCents === undefined) local.totalAssetValue = "An amount in rand, e.g. 1500000.00"
    if (Object.keys(local).length > 0) {
      setErrors(local)
      return
    }
    setSaving(true)
    try {
      const res = await fetch(entityId ? `/api/asset-finance/entities/${entityId}` : "/api/asset-finance/entities", {
        method: entityId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, annualTurnover: turnoverCents, totalAssetValue: assetsCents }),
      })
      const body = (await res.json()) as { id?: string; error?: string; fields?: Record<string, string> }
      if (!res.ok) {
        setErrors(body.fields ?? {})
        toast.error(body.error ?? "Could not save the entity")
        return
      }
      toast.success(entityId ? "Entity updated" : "Entity created")
      router.push(`/asset-finance/entities/${entityId ?? body.id}`)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the entity")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <FormSection number="1" title="Identity" description="As registered with CIPC or the Master of the High Court.">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="type"
            label="Entity type"
            value={values.type}
            options={TYPE_OPTIONS}
            onChange={set("type")}
            error={errors.type}
            disabled={Boolean(entityId)}
            placeholder="Choose…"
          />
          <TextField id="registrationNumber" label="Registration number" required value={values.registrationNumber}
            onChange={set("registrationNumber")} error={errors.registrationNumber}
            hint={values.type ? REGISTRATION_HINT[values.type] : undefined} />
          <TextField id="legalName" label="Legal name" required value={values.legalName} onChange={set("legalName")} error={errors.legalName} />
          <TextField id="tradingName" label="Trading name" value={values.tradingName} onChange={set("tradingName")} error={errors.tradingName} />
          <TextField id="vatNumber" label="VAT number" value={values.vatNumber} onChange={set("vatNumber")} error={errors.vatNumber}
            inputMode="numeric" hint="Ten digits starting with 4" />
        </div>
      </FormSection>

      <FormSection number="2" title="Financials" description="Turnover or asset value with its financial year. These figures feed the NCA classification once a verified AFS is attached as evidence.">
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField id="annualTurnover" label="Annual turnover (R)" value={turnover} onChange={setTurnover}
            error={errors.annualTurnover} inputMode="decimal" />
          <TextField id="totalAssetValue" label="Total asset value (R)" value={assets} onChange={setAssets}
            error={errors.totalAssetValue} inputMode="decimal" />
          <TextField id="financialYearEnd" label="Financial year end" type="date" value={values.financialYearEnd}
            onChange={set("financialYearEnd")} error={errors.financialYearEnd} />
        </div>
      </FormSection>

      <FormSection number="3" title="Address">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="addressLine1" label="Address line 1" value={values.addressLine1} onChange={set("addressLine1")} error={errors.addressLine1} />
          <TextField id="addressLine2" label="Address line 2" value={values.addressLine2} onChange={set("addressLine2")} error={errors.addressLine2} />
          <TextField id="city" label="City" value={values.city} onChange={set("city")} error={errors.city} />
          <TextField id="province" label="Province" value={values.province} onChange={set("province")} error={errors.province} />
          <TextField id="postalCode" label="Postal code" value={values.postalCode} onChange={set("postalCode")} error={errors.postalCode} inputMode="numeric" />
        </div>
      </FormSection>

      <div className="flex justify-end gap-3">
        <Button variant="outline" type="button" onClick={() => router.back()} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={saving}>
          {saving ? "Saving…" : entityId ? "Save changes" : "Create entity"}
        </Button>
      </div>
    </div>
  )
}
