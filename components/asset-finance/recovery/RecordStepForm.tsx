"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { formatIsoDate } from "@/lib/asset-finance/format"
import type { LegalMatterView } from "@/lib/asset-finance/legal-matter-view"
import { AreaField, ChoiceField } from "./legal-fields"
import { useLegalAction } from "./legal-matter-client"
import {
  correctableSteps, emptyStepForm, recordLabel, recordSelectable, stepBody, stepFormError, stepKindsFor, STEP_LABELS,
  type StepForm,
} from "./legal-matter-form"

/** Record a step (POST .../legal-matters/[id]/steps): JSON, or multipart when an evidence file is attached. */
export function RecordStepForm({ matter, today }: { matter: LegalMatterView; today: string }) {
  const kinds = stepKindsFor(matter.regime)
  const [form, setForm] = useState<StepForm>(() => emptyStepForm(today, kinds[0]))
  const [fileKey, setFileKey] = useState(0)
  const { busy, error, setError, run } = useLegalAction()
  const set = <K extends keyof StepForm>(key: K, value: StepForm[K]) => setForm((prev) => ({ ...prev, [key]: value }))
  const corrections = correctableSteps(matter.steps)

  const submit = async () => {
    const problem = stepFormError(form)
    if (problem) return setError(problem)
    if (await run(`/api/asset-finance/legal-matters/${matter.id}/steps`, stepBody(form))) {
      setForm(emptyStepForm(today, form.kind))
      setFileKey((key) => key + 1)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <ChoiceField id="stepKind" label="Step" required value={form.kind} onChange={(v) => set("kind", v as StepForm["kind"])}
          options={kinds.map((kind) => ({ value: kind, label: STEP_LABELS[kind] }))} />
        <TextField id="stepDate" label="Date of the step" type="date" required max={today} value={form.stepDate} onChange={(v) => set("stepDate", v)} />
        {form.kind === "S129_SENT" && (
          <ChoiceField id="stepRecord" label="Section 129 notice" required value={form.section129RecordId} onChange={(v) => set("section129RecordId", v)}
            placeholder={matter.eligibleSection129Records.length === 0 ? "No completed notice on this loan" : "Choose the notice"}
            options={matter.eligibleSection129Records.map((record) => ({
              value: record.id, label: recordLabel(record), disabled: !recordSelectable(record, form.correctsStepId),
            }))} />
        )}
        {corrections.length > 0 && (
          <ChoiceField id="stepCorrects" label="Corrects an earlier step" value={form.correctsStepId} onChange={(v) => set("correctsStepId", v)}
            placeholder="None: a new step"
            options={corrections.map((step) => ({ value: step.id, label: `${STEP_LABELS[step.kind]} · ${formatIsoDate(step.stepDate)}` }))} />
        )}
      </div>
      {form.kind === "ASSET_RECOVERED" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <AreaField id="stepLocation" label="Where the asset is (yard or location)" required value={form.location} onChange={(v) => set("location", v)} />
          <AreaField id="stepCondition" label="Condition of the asset" required value={form.condition} onChange={(v) => set("condition", v)} />
        </div>
      )}
      <AreaField id="stepNote" label="Note" value={form.note} onChange={(v) => set("note", v)} />
      <div className="space-y-1.5">
        <Label htmlFor="stepEvidence" className="text-xs text-[var(--cf-text-secondary)]">Evidence (PDF, JPEG, PNG or WebP, up to 10 MB)</Label>
        <Input key={fileKey} id="stepEvidence" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => set("file", e.target.files?.[0] ?? null)} />
      </div>
      {(form.kind === "SETTLED" || form.kind === "WITHDRAWN") && (
        <label className="flex items-center gap-2 text-sm text-[var(--cf-text)]">
          <input type="checkbox" checked={form.closeMatter} onChange={(e) => set("closeMatter", e.target.checked)} />
          Close the matter with this step
        </label>
      )}
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Recording…" : "Record step"}
      </Button>
      <FormError message={error} />
    </div>
  )
}
