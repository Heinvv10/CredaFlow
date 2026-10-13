"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { FormError, SelectField, sendJson } from "@/components/asset-finance/register-form-controls"
import { ScheduleTable } from "@/components/asset-finance/ScheduleTable"
import { dealStructureBody, type DealFormValues } from "@/lib/asset-finance/deal-form-body"
import { ratePercent } from "@/lib/asset-finance/deal-labels"
import type { StructureResult } from "@/lib/asset-finance/types"
import { DealStructureFields } from "./DealStructureFields"

type Option = { id: string; label: string }
export interface DealFormOptions {
  entities: Option[]
  assets: Option[]
  suppliers: Option[]
  products: Option[]
}
type Preview = StructureResult & { startDate: string; termDays: number; rate: { annualRate: string } }

const INITIAL: DealFormValues = {
  assetId: "", depositRands: "", tradeInRands: "", feesRands: "", balloonRands: "", firstDueDate: "",
  vatDeferralPeriod: "", rateBasis: "PRIME", ratePercent: "", preset: "MONTHLY", periods: "60", skipFirst: "",
  seasonMonths: "", seasonWeight: "", offWeight: "", months: "", steps: "",
}
const choices = (options: Option[], placeholder: string) =>
  Object.fromEntries([["", placeholder], ...options.map((o) => [o.id, o.label])]) as Record<string, string>

export function DealCreateForm({ options }: { options: DealFormOptions }) {
  const router = useRouter()
  const [values, setValues] = useState<DealFormValues>(INITIAL)
  const [parties, setParties] = useState({ entityId: "", supplierId: "", productId: "" })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const set = (key: keyof DealFormValues) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }))
  const structure = useMemo(() => dealStructureBody(values), [values])
  const ready = values.assetId !== "" && values.firstDueDate !== "" && Object.keys(structure.errors).length === 0
  const requestBody = ready ? JSON.stringify(structure.body) : null

  // Live preview: re-solve 400 ms after the structure stops changing.
  useEffect(() => {
    if (requestBody === null) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/asset-finance/deals/preview", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody, signal: controller.signal,
        })
        const data = (await res.json().catch(() => ({}))) as Preview & { error?: string; fields?: Record<string, string> }
        if (res.ok) {
          setPreview(data)
          setPreviewError(null)
        } else {
          setPreview(null)
          setPreviewError([data.error, ...Object.entries(data.fields ?? {}).map(([k, m]) => `${k} ${m}`)].filter(Boolean).join(" · "))
        }
      } catch (e) {
        if (!controller.signal.aborted) setPreviewError(e instanceof Error ? e.message : "Preview failed")
      }
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [requestBody])

  const save = async () => {
    if (!ready) {
      setFields(structure.errors)
      setError("Choose the asset and first due date, and check the highlighted fields")
      return
    }
    setSaving(true)
    setError(null)
    const result = await sendJson("/api/asset-finance/deals", "POST", { ...structure.body, ...parties })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    router.push(`/asset-finance/deals/${(result.body as { id: string }).id}`)
  }

  const allErrors = { ...structure.errors, ...fields }
  return (
    <div className="space-y-5">
      <DataPanel title="Parties and asset" density="loose">
        <div className="space-y-4">
          <FormError message={error} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectField id="entityId" label="Borrower (entity)" required value={parties.entityId}
              onChange={(entityId) => setParties((p) => ({ ...p, entityId }))} options={choices(options.entities, "Choose an entity")} error={fields.entityId} />
            <SelectField id="assetId" label="Asset" required value={values.assetId}
              onChange={set("assetId")} options={choices(options.assets, "Choose an asset")} error={fields.assetId} />
            <SelectField id="supplierId" label="Supplier" required value={parties.supplierId}
              onChange={(supplierId) => setParties((p) => ({ ...p, supplierId }))} options={choices(options.suppliers, "Choose a supplier")} error={fields.supplierId} />
            <SelectField id="productId" label="Product" required value={parties.productId}
              onChange={(productId) => setParties((p) => ({ ...p, productId }))} options={choices(options.products, "Choose a product")} error={fields.productId} />
          </div>
        </div>
      </DataPanel>
      <DataPanel title="Structure" description="The schedule below re-solves as you type" density="loose">
        <DealStructureFields values={values} set={set} errors={allErrors} />
      </DataPanel>
      <DataPanel
        title="Schedule preview"
        description={preview ? `Indicative from ${preview.startDate} at ${ratePercent(preview.rate.annualRate)} a year · ${preview.termDays} days` : undefined}
      >
        {previewError && <FormError message={previewError} />}
        {!preview && !previewError && (
          <p className="text-sm text-[var(--cf-text-muted)]">Choose an asset, a rate and the first due date to see the schedule.</p>
        )}
        {ready && preview && <ScheduleTable {...preview} />}
      </DataPanel>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {saving ? "Saving…" : "Create deal"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => router.push("/asset-finance/deals")}>Cancel</Button>
      </div>
    </div>
  )
}
