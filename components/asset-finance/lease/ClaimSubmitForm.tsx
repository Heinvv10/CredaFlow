"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField } from "@/components/asset-finance/register-form-controls"
import { claimBody } from "@/lib/asset-finance/lease-staff-bodies"
import { useLeaseAction } from "./lease-action"

type Choice = { id: string; label: string }
export interface ClaimOptions {
  suppliers: Choice[]
  /** Documents filed on the lease's deal: the provider's invoice is one of them. */
  documents: Choice[]
  readings: Choice[]
}

const choices = (options: Choice[], placeholder: string) =>
  Object.fromEntries([["", placeholder], ...options.map((o) => [o.id, o.label])]) as Record<string, string>

/** Submit a maintenance claim (POST .../claims): an approved supplier, the provider's invoice filed on the deal, the amount ex VAT and the work. */
export function ClaimSubmitForm({ url, options }: { url: string; options: ClaimOptions }) {
  const [values, setValues] = useState({ supplierId: "", documentId: "", amountRands: "", description: "", meterReadingId: "" })
  const { busy, error, setError, run } = useLeaseAction()
  const set = (key: keyof typeof values) => (value: string) => setValues((v) => ({ ...v, [key]: value }))

  const submit = async () => {
    const built = claimBody(values)
    if ("error" in built) return setError(built.error)
    if (await run(url, built.body)) setValues({ supplierId: "", documentId: "", amountRands: "", description: "", meterReadingId: "" })
  }

  return (
    <div className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4">
      <h3 className="text-xs font-semibold text-[var(--cf-text-secondary)]">Submit a claim</h3>
      {options.suppliers.length === 0 && (
        <p className="text-xs text-[var(--cf-text-muted)]">No provider can be chosen: a provider must be an active supplier with an approved bank account.</p>
      )}
      {options.documents.length === 0 && (
        <p className="text-xs text-[var(--cf-text-muted)]">The provider&apos;s invoice must be filed on the lease&apos;s deal first.</p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField id="claimSupplier" label="Provider" required value={values.supplierId} onChange={set("supplierId")} options={choices(options.suppliers, "Choose a provider")} />
        <SelectField id="claimDocument" label="Provider's invoice" required value={values.documentId} onChange={set("documentId")} options={choices(options.documents, "Choose a document")} />
        <TextField id="claimAmount" label="Amount ex VAT (R)" required inputMode="decimal" value={values.amountRands} onChange={set("amountRands")} />
        <SelectField id="claimReading" label="Meter reading (optional)" value={values.meterReadingId} onChange={set("meterReadingId")} options={choices(options.readings, "None")} />
      </div>
      <TextField id="claimDescription" label="Work claimed" required value={values.description} onChange={set("description")} />
      <FormError message={error} />
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Submitting…" : "Submit claim"}
      </Button>
    </div>
  )
}
