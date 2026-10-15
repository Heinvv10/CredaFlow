"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { ChoiceField, type ChoiceOption } from "./legal-fields"
import { useLegalAction } from "./legal-matter-client"

/** Appoint (or re-appoint, while the matter is open) the attorney: POST .../legal-matters/[id]/attorney. */
export function AttorneyForm({ matterId, suppliers, current, today }: {
  matterId: string
  suppliers: ChoiceOption[]
  current: string | null
  today: string
}) {
  const [supplierId, setSupplierId] = useState(current ?? "")
  const [appointedOn, setAppointedOn] = useState(today)
  const { busy, error, setError, run } = useLegalAction()

  const submit = async () => {
    if (!supplierId) return setError("Choose the attorney's supplier record")
    await run(`/api/asset-finance/legal-matters/${matterId}/attorney`, { supplierId, appointedOn })
  }

  if (suppliers.length === 0) {
    return <p className="text-sm text-[var(--cf-text-muted)]">Register the attorney as a supplier first, then appoint them here.</p>
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
        <ChoiceField id="attorneySupplier" label="Attorney (supplier)" value={supplierId} onChange={setSupplierId} options={suppliers} placeholder="Choose a supplier" required />
        <TextField id="attorneyDate" label="Appointed on" type="date" required max={today} value={appointedOn} onChange={setAppointedOn} />
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {busy ? "Saving…" : current ? "Change attorney" : "Appoint attorney"}
        </Button>
      </div>
      <FormError message={error} />
    </div>
  )
}
