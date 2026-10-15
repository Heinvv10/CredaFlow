"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import type { ValuationSource } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { MoneyField } from "@/components/asset-finance/MoneyField"
import { ChoiceField } from "./legal-fields"
import { useLegalAction } from "./legal-matter-client"
import { VALUATION_SOURCE_LABELS } from "./recovery-model"
import { emptyValuationForm, valuationBody, type ValuationForm as Form } from "./recovery-forms"

export interface SurrenderLink { id: string; hasValuation: boolean }

/**
 * Value the recovered asset. A non-NCA or s131 recovery records its own
 * valuation. An s127 recovery reuses its surrender's valuation: when the
 * surrender is not valued yet the form values the surrender first, then the
 * recovery takes it over.
 */
export function ValuationForm({ recoveryId, today, surrender }: { recoveryId: string; today: string; surrender: SurrenderLink | null }) {
  const [form, setForm] = useState<Form>(() => emptyValuationForm(today))
  const { busy, error, setError, runAll } = useLegalAction()
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => ({ ...prev, [key]: value }))
  const recoveryUrl = `/api/asset-finance/recoveries/${recoveryId}/valuation`

  if (surrender?.hasValuation) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--cf-text-muted)]">The surrender is already valued: an s127 recovery takes that valuation over.</p>
        <Button size="sm" disabled={busy} onClick={() => runAll([{ url: recoveryUrl, body: {} }])}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {busy ? "Recording…" : "Use the surrender's valuation"}
        </Button>
        <FormError message={error} />
      </div>
    )
  }

  const submit = async () => {
    const built = valuationBody(form)
    if ("error" in built) return setError(built.error)
    await runAll(surrender
      ? [{ url: `/api/asset-finance/surrenders/${surrender.id}/valuation`, body: built.body }, { url: recoveryUrl, body: {} }]
      : [{ url: recoveryUrl, body: built.body }])
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="valuedOn" label="Valuation date" type="date" required max={today} value={form.valuedOn} onChange={(v) => set("valuedOn", v)} />
        <ChoiceField id="valuationSource" label="Source" required value={form.source} onChange={(v) => set("source", v as ValuationSource)}
          options={(Object.keys(VALUATION_SOURCE_LABELS) as ValuationSource[]).map((s) => ({ value: s, label: VALUATION_SOURCE_LABELS[s] }))} />
        <TextField id="valuerName" label="Valuer" required value={form.valuerName} onChange={(v) => set("valuerName", v)} />
        <MoneyField id="valuationAmount" label="Valuation (R)" required value={form.amount} onChange={(v) => set("amount", v)} />
      </div>
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Recording…" : "Record valuation"}
      </Button>
      <FormError message={error} />
    </div>
  )
}
