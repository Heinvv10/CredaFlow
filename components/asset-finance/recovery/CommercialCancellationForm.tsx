"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, SelectField } from "@/components/asset-finance/register-form-controls"
import { useLegalAction } from "./legal-matter-client"

export function CommercialCancellationForm({ loanId, documents, minDate, today }: { loanId: string; documents: Array<{ id: string; name: string }>; minDate: string; today: string }) {
  const [cancelledOn, setCancelledOn] = useState("")
  const [document, setDocument] = useState("")
  const [basis, setBasis] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const { busy, error, run } = useLegalAction()
  const options = Object.fromEntries([["", "Choose cancellation evidence"], ...documents.map((d) => [d.id, d.name])])
  return <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(`/api/asset-finance/loans/${loanId}/commercial-cancellation`, { cancelledOn, evidenceDocumentId: document, basis, cancellationConfirmed: confirmed }) }}>
    <TextField id={`cancellation-date-${loanId}`} label="Actual effective cancellation date" type="date" min={minDate} max={today} value={cancelledOn} onChange={setCancelledOn} required />
    <SelectField id={`cancellation-document-${loanId}`} label="Cancellation evidence" value={document} onChange={setDocument} options={options} required />
    <TextField id={`cancellation-basis-${loanId}`} label="Evidence establishing cancellation and its effective date" value={basis} onChange={setBasis} required />
    <label className="flex gap-2 text-sm text-[var(--cf-text-secondary)]"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I verified actual cancellation and its effective date from this evidence. Possession or voluntary return alone does not establish cancellation.</label>
    <Button size="sm" disabled={busy || !cancelledOn || !document || basis.trim().length < 10 || !confirmed}>{busy ? "Recording…" : "Record evidenced cancellation"}</Button>
    <FormError message={error} />
  </form>
}
