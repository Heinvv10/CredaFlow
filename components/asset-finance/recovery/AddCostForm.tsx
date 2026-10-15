"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import type { RecoveryCostType, RecoveryRoute } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { MoneyField } from "@/components/asset-finance/MoneyField"
import { COST_TYPE_LABELS } from "@/lib/asset-finance/recovery-labels"
import { AreaField, ChoiceField, type ChoiceOption } from "./legal-fields"
import { useLegalAction } from "./legal-matter-client"
import { costTreatments, TREATMENT_LABELS, type CostAllowLists } from "./recovery-model"
import { COST_ENTRY, costSubmission, emptyCostForm, type CostForm } from "./recovery-cost-adapter"

/** Add a supplier cost to the ledger (see recovery-cost-adapter.ts for how it is entered). */
export function AddCostForm({ recoveryId, route, today, lists, suppliers, legalSteps }: {
  recoveryId: string
  route: RecoveryRoute
  today: string
  lists: CostAllowLists
  suppliers: ChoiceOption[]
  legalSteps: ChoiceOption[]
}) {
  const types = (Object.keys(COST_TYPE_LABELS) as RecoveryCostType[]).filter((type) => costTreatments(route, type, lists).length > 0)
  const firstType = types[0]
  const [form, setForm] = useState<CostForm | null>(() => (firstType ? emptyCostForm(today, firstType, costTreatments(route, firstType, lists)[0]) : null))
  const { busy, error, setError, run } = useLegalAction()
  if (!form || !firstType) return <p className="text-sm text-[var(--cf-text-muted)]">No cost type is allowed on this route for this lender.</p>

  const set = <K extends keyof CostForm>(key: K, value: CostForm[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  const treatments = costTreatments(route, form.type, lists)
  const pickType = (type: RecoveryCostType) => setForm({ ...form, type, treatment: costTreatments(route, type, lists)[0], legalStepId: "" })

  const submit = async () => {
    const built = costSubmission(recoveryId, form)
    if ("error" in built) return setError(built.error)
    if (await run(built.url, built.body)) setForm(emptyCostForm(today, form.type, form.treatment))
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--cf-text-muted)]">{COST_ENTRY.entryHint}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <ChoiceField id="costType" label="Cost" required value={form.type} onChange={(v) => pickType(v as RecoveryCostType)}
          options={types.map((type) => ({ value: type, label: COST_TYPE_LABELS[type] }))} />
        <ChoiceField id="costTreatment" label="Treatment" required value={form.treatment} onChange={(v) => set("treatment", v as CostForm["treatment"])}
          options={treatments.map((t) => ({ value: t, label: TREATMENT_LABELS[t] }))} />
        <MoneyField id="costNet" label="Net amount (R)" required value={form.net} onChange={(v) => set("net", v)} />
        <MoneyField id="costVat" label="VAT (R, 0 if not a VAT vendor)" required value={form.vat} onChange={(v) => set("vat", v)} />
        <ChoiceField id="costSupplier" label="Supplier" value={form.supplierId} onChange={(v) => set("supplierId", v)} placeholder="No supplier record" options={suppliers} />
        <TextField id="costInvoice" label="Supplier invoice reference" required value={form.supplierInvoiceRef} onChange={(v) => set("supplierInvoiceRef", v)} />
        <TextField id="costDate" label="Date incurred" type="date" required max={today} value={form.incurredOn} onChange={(v) => set("incurredOn", v)} />
        {form.type === "LEGAL_TAXED" && (
          <ChoiceField id="costLegalStep" label="Follows legal step" required value={form.legalStepId} onChange={(v) => set("legalStepId", v)}
            placeholder={legalSteps.length === 0 ? "No judgment or settlement step yet" : "Choose the step"} options={legalSteps} />
        )}
      </div>
      <AreaField id="costNote" label="Note" value={form.note} onChange={(v) => set("note", v)} />
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Recording…" : COST_ENTRY.submitLabel}
      </Button>
      <FormError message={error} />
    </div>
  )
}
