"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { MANUAL_VALUATION_SOURCE_LABELS } from "@/lib/asset-finance/asset-labels"
import { randsToCents } from "@/lib/asset-finance/money-input"

export function ValuationForm({ assetId }: { assetId: string }) {
  const router = useRouter()
  const [valuedOn, setValuedOn] = useState("")
  const [source, setSource] = useState<keyof typeof MANUAL_VALUATION_SOURCE_LABELS>("DEALER")
  const [valuerName, setValuerName] = useState("")
  const [amount, setAmount] = useState("")
  const [documentId, setDocumentId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const amountCents = randsToCents(amount)
    if (amountCents === null) {
      setFields({ amountCents: "must be an amount in rands" })
      setError("Check the highlighted fields")
      return
    }
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson(`/api/asset-finance/assets/${assetId}/valuations`, "POST", {
      valuedOn, source, valuerName, amountCents, documentId: documentId.trim() || null,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    setValuedOn(""); setValuerName(""); setAmount(""); setDocumentId("")
    router.refresh()
  }

  return (
    <div className="space-y-3 border-t border-[var(--cf-border-subtle)] pt-4">
      <h3 className="text-sm font-semibold text-[var(--cf-text)]">Record a valuation</h3>
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
        <TextField id="valuedOn" label="Valued on" type="date" required value={valuedOn} onChange={setValuedOn} error={fields.valuedOn} />
        <SelectField id="source" label="Source" required value={source} onChange={setSource} options={MANUAL_VALUATION_SOURCE_LABELS} error={fields.source} />
        <TextField id="valuerName" label="Valuer" required value={valuerName} onChange={setValuerName} error={fields.valuerName} />
        <TextField id="amount" label="Amount (R)" required inputMode="decimal" value={amount} onChange={setAmount} error={fields.amountCents} />
        <TextField id="documentId" label="Report document ID" value={documentId} onChange={setDocumentId} error={fields.documentId} />
      </div>
      <Button size="sm" onClick={submit} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {saving ? "Saving…" : "Record valuation"}
      </Button>
    </div>
  )
}
