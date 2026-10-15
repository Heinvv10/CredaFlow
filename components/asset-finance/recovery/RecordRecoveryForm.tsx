"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import type { RecoveryRoute } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { AreaField, ChoiceField, type ChoiceOption } from "./legal-fields"
import { useLegalAction } from "./legal-matter-client"
import { emptyRecordForm, recordRecoveryBody, type RecordRecoveryForm as Form } from "./recovery-forms"

/**
 * Record that the asset is in the yard (POST .../loans/[loanId]/recoveries):
 * a non-NCA voluntary hand-over, or the loan's s127 surrender (NCA). An
 * s131 or court-order recovery comes from the legal matter's recovered step.
 */
export function RecordRecoveryForm({ loanId, route, surrenders, lease, today }: {
  loanId: string
  route: Extract<RecoveryRoute, "NCA_S127_SURRENDER" | "NON_NCA_VOLUNTARY">
  surrenders: ChoiceOption[]
  lease: boolean
  today: string
}) {
  const [form, setForm] = useState<Form>(() => ({ ...emptyRecordForm(today), surrenderRequestId: surrenders.length === 1 ? surrenders[0].value : "" }))
  const { busy, error, setError, run } = useLegalAction()
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => ({ ...prev, [key]: value }))

  const submit = async () => {
    const built = recordRecoveryBody(route, form)
    if ("error" in built) return setError(built.error)
    await run(`/api/asset-finance/loans/${loanId}/recoveries`, built.body)
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {route === "NCA_S127_SURRENDER" && (
          <ChoiceField id="recoverySurrender" label="Surrender" required value={form.surrenderRequestId} onChange={(v) => set("surrenderRequestId", v)}
            placeholder="Choose the surrender" options={surrenders} />
        )}
        <TextField id="recoveredOn" label="Recovered on" type="date" required max={today} value={form.recoveredOn} onChange={(v) => set("recoveredOn", v)} />
        {lease && <TextField id="recoveryMeter" label="Meter reading at inspection (optional)" inputMode="numeric" value={form.meterReading} onChange={(v) => set("meterReading", v)} />}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <AreaField id="recoveryLocation" label="Where the asset is (yard or location)" required value={form.location} onChange={(v) => set("location", v)} />
        <AreaField id="recoveryCondition" label="Condition of the asset" required value={form.condition} onChange={(v) => set("condition", v)} />
      </div>
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Recording…" : "Record recovery"}
      </Button>
      <FormError message={error} />
    </div>
  )
}
