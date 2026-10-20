"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, sendJson } from "@/components/asset-finance/register-form-controls"
import { ScheduleTable } from "@/components/asset-finance/ScheduleTable"
import { DealStructureFields } from "@/app/(dashboard)/asset-finance/deals/new/DealStructureFields"
import { dealStructureBody, type DealFormValues } from "@/lib/asset-finance/deal-form-body"
import { ratePercent } from "@/lib/asset-finance/deal-labels"
import { dealFieldLabel, describeFieldErrors, describeSolverError } from "@/lib/asset-finance/labels"
import { formatIsoDate } from "@/lib/asset-finance/format"
import type { StructureResult } from "@/lib/asset-finance/types"
import type { BorrowerChoice, DealerWizardOptions } from "./types"

type Preview = StructureResult & { startDate: string; termDays: number; rate: { annualRate: string } }

const INITIAL: Omit<DealFormValues, "assetId"> = {
  contractType: "INSTALMENT_SALE", depositRands: "", tradeInRands: "", feesRands: "", balloonRands: "", firstDueDate: "",
  vatDeferralPeriod: "", rateBasis: "PRIME", ratePercent: "", preset: "MONTHLY", periods: "", skipFirst: "",
  seasonMonths: "", seasonWeight: "", offWeight: "", months: "", steps: "",
}
const choices = (rows: { id: string; name: string }[], placeholder: string) => Object.fromEntries([["", placeholder], ...rows.map((r) => [r.id, r.name])])

/**
 * Step 4: supplier, product and the structure, priced live by the lender's
 * solver (POST /api/dealer/deals/preview); then the draft deal is created and
 * the dealer goes on to documents, consent and submit on the deal page.
 */
export function StructureStep({ options, borrower, assetId }: { options: DealerWizardOptions; borrower: BorrowerChoice; assetId: string }) {
  const router = useRouter()
  const [values, setValues] = useState<DealFormValues>({ ...INITIAL, assetId })
  const [supplierId, setSupplierId] = useState(options.defaultSupplierId ?? "")
  const [productId, setProductId] = useState(options.products.length === 1 ? options.products[0].id : "")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const set = (key: keyof DealFormValues) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }))
  const structure = useMemo(() => dealStructureBody(values), [values])
  const ready = values.firstDueDate !== "" && Object.keys(structure.errors).length === 0
  // As the staff form: an instalment sale or finance lease to a sole proprietor is priced as NCA credit; the lender confirms the regime.
  const requestBody = ready ? JSON.stringify({ ...structure.body, nca: borrower.kind === "CLIENT" }) : null

  useEffect(() => {
    if (requestBody === null) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/dealer/deals/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody, signal: controller.signal })
        const data = (await res.json().catch(() => ({}))) as Preview & { error?: string; fields?: Record<string, string> }
        if (res.ok && data.error === undefined) {
          setPreview(data)
          setPreviewError(null)
        } else {
          setPreview(null)
          const fieldErrors = data.fields ?? {}
          setPreviewError((Object.keys(fieldErrors).length > 0 ? describeFieldErrors(fieldErrors) : [data.error ? describeSolverError(data.error) : `The quote could not be solved (${res.status})`]).join(" · "))
        }
      } catch {
        if (!controller.signal.aborted) setPreviewError("The quote could not be loaded. Check your connection and try again.")
      }
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [requestBody])

  async function create() {
    if (!ready) {
      setFields(structure.errors)
      return setError("Choose the first due date and check the highlighted fields")
    }
    setSaving(true)
    setError(null)
    const result = await sendJson("/api/dealer/deals", "POST", {
      ...structure.body, supplierId, productId,
      ...(borrower.kind === "ENTITY" ? { entityId: borrower.entityId } : { clientId: borrower.clientId }),
    })
    setSaving(false)
    if (!result.ok) {
      const keys = Object.keys(result.fields)
      setFields(result.fields)
      return setError(keys.length > 0 ? `Check the highlighted fields: ${keys.map(dealFieldLabel).join(", ")}` : describeSolverError(result.error))
    }
    router.push(`/dealer/deals/${(result.body as { id: string }).id}`)
  }

  const allErrors = { ...structure.errors, ...fields }
  return (
    <div className="space-y-5">
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SelectField id="contractType" label="Agreement type" required value={values.contractType} onChange={set("contractType")}
          options={{ INSTALMENT_SALE: "Instalment sale", FINANCE_LEASE: "Finance lease" }} error={fields.contractType} />
        <SelectField id="supplierId" label="Supplier" required value={supplierId} onChange={setSupplierId} options={choices(options.suppliers, "Choose a supplier")} error={fields.supplierId} />
        <SelectField id="productId" label="Product" required value={productId} onChange={setProductId} options={choices(options.products, "Choose a product")} error={fields.productId} />
      </div>
      <DealStructureFields values={values} set={set} errors={allErrors} />
      <div className="rounded-md border border-[var(--cf-border-subtle)] p-3">
        <p className="mb-2 text-sm font-semibold text-[var(--cf-text)]">
          Quote{preview ? `: from ${formatIsoDate(preview.startDate)} at ${ratePercent(preview.rate.annualRate)} a year` : ""}
        </p>
        {previewError ? <FormError message={previewError} /> : null}
        {!preview && !previewError ? <p className="text-sm text-[var(--cf-text-muted)]">Choose a rate and the first due date to see the schedule.</p> : null}
        {ready && preview ? <ScheduleTable {...preview} /> : null}
        <p className="mt-2 text-xs text-[var(--cf-text-muted)]">Indicative: the lender confirms the terms when it assesses the deal.</p>
      </div>
      <Button size="sm" onClick={create} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {saving ? "Saving…" : "Create the draft deal"}
      </Button>
    </div>
  )
}
