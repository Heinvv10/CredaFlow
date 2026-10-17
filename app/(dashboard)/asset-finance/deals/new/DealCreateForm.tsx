"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { FormError, SelectField, sendJson } from "@/components/asset-finance/register-form-controls"
import { ScheduleTable } from "@/components/asset-finance/ScheduleTable"
import { LeaseSchedulePreview } from "@/components/asset-finance/lease/LeaseSchedulePreview"
import { dealStructureBody, type DealFormValues } from "@/lib/asset-finance/deal-form-body"
import { LEASE_INITIAL, leaseDealBody, type LeaseFormValues } from "@/lib/asset-finance/lease-form-body"
import { isLeaseContract, type LeaseContractType, type UsageUnit } from "@/lib/asset-finance/lease-input"
import type { LeaseScheduleView } from "@/lib/asset-finance/lease-view"
import { CONTRACT_TYPE_LABELS, ratePercent } from "@/lib/asset-finance/deal-labels"
import { dealFieldLabel, describeFieldErrors, describeSolverError } from "@/lib/asset-finance/labels"
import { formatIsoDate } from "@/lib/asset-finance/format"
import type { StructureResult } from "@/lib/asset-finance/types"
import { DealStructureFields } from "./DealStructureFields"
import { LeaseStructureFields } from "./LeaseStructureFields"

type Option = { id: string; label: string }
export interface DealFormOptions {
  entities: Option[]
  clients: Option[]
  /** usageUnit: the asset class's default unit for a lease's contracted usage. */
  assets: (Option & { usageUnit?: UsageUnit })[]
  suppliers: Option[]
  products: Option[]
}
type Preview = StructureResult & { startDate: string; termDays: number; rate: { annualRate: string }; lease?: LeaseScheduleView }

const INITIAL: DealFormValues = {
  assetId: "", contractType: "INSTALMENT_SALE", depositRands: "", tradeInRands: "", feesRands: "", balloonRands: "", firstDueDate: "",
  vatDeferralPeriod: "", rateBasis: "PRIME", ratePercent: "", preset: "MONTHLY", periods: "", skipFirst: "",
  seasonMonths: "", seasonWeight: "", offWeight: "", months: "", steps: "",
}
const choices = (options: Option[], placeholder: string) =>
  Object.fromEntries([["", placeholder], ...options.map((o) => [o.id, o.label])]) as Record<string, string>

export function DealCreateForm({ options }: { options: DealFormOptions }) {
  const router = useRouter()
  const [values, setValues] = useState<DealFormValues>(INITIAL)
  const [leaseType, setLeaseType] = useState<LeaseContractType | null>(null)
  const [lease, setLeaseValues] = useState<LeaseFormValues>(LEASE_INITIAL)
  const [parties, setParties] = useState({ borrowerType: "ENTITY" as "ENTITY" | "CLIENT", entityId: "", clientId: "", supplierId: "", productId: "" })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewFields, setPreviewFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const set = (key: keyof DealFormValues) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }))
  const setLease = (key: keyof LeaseFormValues) => (value: string) => setLeaseValues((prev) => ({ ...prev, [key]: value }))
  const structure = useMemo(() => (leaseType ? leaseDealBody(values, lease, leaseType) : dealStructureBody(values)), [values, lease, leaseType])
  const ready = values.assetId !== "" && values.firstDueDate !== "" && Object.keys(structure.errors).length === 0
  // A lease is never an NCA credit agreement, whoever the lessee is.
  const requestBody = ready ? JSON.stringify({ ...structure.body, nca: leaseType === null && parties.borrowerType === "CLIENT" }) : null

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
        if (res.ok && data.error === undefined) {
          setPreview(data)
          setPreviewError(null)
          setPreviewFields({})
        } else {
          // 400 (field errors) and 200 { error } (the structure cannot be
          // solved) are answers about the input: shown in the form, never thrown.
          const fieldErrors = data.fields ?? {}
          setPreview(null)
          setPreviewFields(fieldErrors)
          const lines = Object.keys(fieldErrors).length > 0
            ? describeFieldErrors(fieldErrors)
            : [data.error ? describeSolverError(data.error) : `The preview could not be solved (${res.status})`]
          setPreviewError(lines.join(" · "))
        }
      } catch {
        if (!controller.signal.aborted) setPreviewError("The preview could not be loaded. Check your connection and try again.")
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
    const result = await sendJson("/api/asset-finance/deals", "POST", {
      ...structure.body, supplierId: parties.supplierId, productId: parties.productId,
      ...(parties.borrowerType === "ENTITY" ? { entityId: parties.entityId } : { clientId: parties.clientId }),
    })
    setSaving(false)
    if (!result.ok) {
      const keys = Object.keys(result.fields)
      setError(keys.length > 0 ? `Check the highlighted fields: ${keys.map(dealFieldLabel).join(", ")}` : describeSolverError(result.error))
      setFields(result.fields)
      return
    }
    router.push(`/asset-finance/deals/${(result.body as { id: string }).id}`)
  }

  const allErrors = { ...previewFields, ...structure.errors, ...fields }
  return (
    <div className="space-y-5">
      <DataPanel title="Parties and asset" density="loose">
        <div className="space-y-4">
          <FormError message={error} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectField id="borrowerType" label={leaseType ? "Lessee type" : "Borrower type"} required value={parties.borrowerType}
              onChange={(borrowerType) => setParties((p) => ({ ...p, borrowerType: borrowerType as "ENTITY" | "CLIENT", entityId: "", clientId: "" }))}
              options={{ ENTITY: "Entity", CLIENT: "Sole proprietor" }} error={fields.borrower} />
            {parties.borrowerType === "ENTITY" ? (
              <SelectField id="entityId" label={leaseType ? "Lessee (entity)" : "Borrower (entity)"} required value={parties.entityId}
                onChange={(entityId) => setParties((p) => ({ ...p, entityId }))} options={choices(options.entities, "Choose an entity")} error={fields.entityId} />
            ) : (
              <SelectField id="clientId" label={leaseType ? "Lessee (sole proprietor)" : "Borrower (sole proprietor)"} required value={parties.clientId}
                onChange={(clientId) => setParties((p) => ({ ...p, clientId }))} options={choices(options.clients, "Choose a client")} error={fields.clientId} />
            )}
            <SelectField id="contractType" label="Agreement type" required value={leaseType ?? values.contractType}
              onChange={(contractType) => {
                if (isLeaseContract(contractType)) return setLeaseType(contractType)
                setLeaseType(null)
                set("contractType")(contractType)
              }}
              options={CONTRACT_TYPE_LABELS} error={fields.contractType} />
            <SelectField id="assetId" label="Asset" required value={values.assetId}
              onChange={(assetId) => {
                set("assetId")(assetId)
                const unit = options.assets.find((a) => a.id === assetId)?.usageUnit
                if (unit) setLeaseValues((prev) => ({ ...prev, usageUnit: unit }))
              }}
              options={choices(options.assets, "Choose an asset")} error={fields.assetId} />
            <SelectField id="supplierId" label="Supplier" required value={parties.supplierId}
              onChange={(supplierId) => setParties((p) => ({ ...p, supplierId }))} options={choices(options.suppliers, "Choose a supplier")} error={fields.supplierId} />
            <div className="space-y-1.5">
              <SelectField id="productId" label="Product" required value={parties.productId}
                onChange={(productId) => setParties((p) => ({ ...p, productId }))} options={choices(options.products, "Choose a product")} error={fields.productId} />
              <p className="text-xs text-[var(--cf-text-muted)]">
                Lists only active asset-finance products (product type &quot;Asset finance&quot; in Settings → Products).
              </p>
            </div>
          </div>
        </div>
      </DataPanel>
      <DataPanel title="Structure" description="The schedule below re-solves as you type" density="loose">
        {leaseType ? (
          <LeaseStructureFields values={values} lease={lease} maintenance={leaseType === "FULL_MAINTENANCE_LEASE"} set={set} setLease={setLease} errors={allErrors} />
        ) : (
          <DealStructureFields values={values} set={set} errors={allErrors} />
        )}
      </DataPanel>
      <DataPanel
        title="Schedule preview"
        description={preview ? `Indicative from ${formatIsoDate(preview.startDate)} at ${ratePercent(preview.rate.annualRate)} a year · ${preview.termDays} days` : undefined}
      >
        {previewError && <FormError message={previewError} />}
        {!preview && !previewError && (
          <p className="text-sm text-[var(--cf-text-muted)]">Choose an asset, a rate and the first due date to see the schedule.</p>
        )}
        {ready && preview && leaseType === null && !preview.lease && <ScheduleTable {...preview} />}
        {ready && preview?.lease && leaseType !== null && (
          <LeaseSchedulePreview lease={preview.lease} capitalCents={preview.financedAmountCents}
            residualCents={Number(structure.body.balloonCents ?? 0)} maintenance={leaseType === "FULL_MAINTENANCE_LEASE"} />
        )}
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
