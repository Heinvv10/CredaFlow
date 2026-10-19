"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FormError, SelectField, sendJson } from "@/components/asset-finance/register-form-controls"

/** Asks the dealer for a document. The note is shown to the dealer: never a credit reason. */
export function DealerDocumentRequestForm({ dealId, docTypes }: { dealId: string; docTypes: Record<string, string> }) {
  const router = useRouter()
  const [docType, setDocType] = useState(Object.keys(docTypes)[0] ?? "")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/deals/${dealId}/document-requests`, "POST", { docType, note })
    setSaving(false)
    if (!result.ok) return setError(result.error)
    setNote("")
    router.refresh()
  }
  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] p-3">
      <FormError message={error} />
      <div className="max-w-sm">
        <SelectField id="dr-doc-type" label="Document" value={docType} onChange={setDocType} options={docTypes} />
      </div>
      <Label htmlFor="dr-note" className="text-xs text-[var(--cf-text-secondary)]">Note to the dealer *</Label>
      <p className="text-xs text-[var(--cf-warning)]">The dealer sees this note. Do not give credit reasons or anything from the credit assessment.</p>
      <Textarea id="dr-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="sm" onClick={submit} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        Request document
      </Button>
    </div>
  )
}
