"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField } from "@/components/asset-finance/register-form-controls"
import { electionBody, inspectionBody, type DamageLine } from "@/lib/asset-finance/lease-staff-bodies"
import { useLeaseAction } from "./lease-action"

// The two forms of a lease's end of term (POST .../end-of-term/[action]):
// the election and the return inspection. The other steps are buttons.

type Outcome = "RETURN" | "EXTEND" | "PURCHASE"
const OUTCOME_LABELS: Record<Outcome, string> = {
  RETURN: "Return the asset (inspection, then invoice)",
  EXTEND: "Extend month to month",
  PURCHASE: "Purchase the asset (at market value)",
}

export interface ValuationChoice {
  id: string
  label: string
  amountRands: string
}

/** The lessee's one, final choice, recorded by staff. A purchase rests on a valuation dated within the tenant's window. */
export function ElectForm({ url, valuations, maxAgeDays }: { url: string; valuations: ValuationChoice[]; maxAgeDays: number }) {
  const [outcome, setOutcome] = useState<Outcome>("RETURN")
  const [valuationId, setValuationId] = useState("")
  const [priceRands, setPriceRands] = useState("")
  const { busy, error, setError, run } = useLeaseAction()
  const valuationOptions = Object.fromEntries([["", "Choose a valuation"], ...valuations.map((v) => [v.id, v.label])]) as Record<string, string>

  const submit = async () => {
    const built = electionBody({ outcome, valuationId, priceRands })
    if ("error" in built) return setError(built.error)
    await run(url, built.body)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--cf-text-muted)]">The choice is the lessee&apos;s and is final: one outcome, recorded once.</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SelectField<Outcome> id="eotOutcome" label="Outcome" required value={outcome} onChange={setOutcome} options={OUTCOME_LABELS} />
        {outcome === "PURCHASE" && (
          <>
            <SelectField id="eotValuation" label="Valuation" required value={valuationId} options={valuationOptions}
              onChange={(id) => {
                setValuationId(id)
                const picked = valuations.find((v) => v.id === id)
                if (picked && priceRands === "") setPriceRands(picked.amountRands)
              }} />
            <TextField id="eotPrice" label="Price ex VAT (R)" required inputMode="decimal" value={priceRands} onChange={setPriceRands} />
          </>
        )}
      </div>
      {outcome === "PURCHASE" && (
        <p className="text-xs text-[var(--cf-text-muted)]">
          {valuations.length === 0
            ? `No valuation of the asset is dated within ${maxAgeDays} days: record one on the asset page first.`
            : `Only valuations dated within ${maxAgeDays} days are offered; the price may not be below the valuation.`}
        </p>
      )}
      <FormError message={error} />
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Recording…" : "Record the choice"}
      </Button>
    </div>
  )
}

/** The return inspection: condition, damage items assessed ex VAT, and the final meter reading when usage is contracted. */
export function InspectionForm({ url, today, usageUnitLabel }: { url: string; today: string; usageUnitLabel: string | null }) {
  const [inspectedOn, setInspectedOn] = useState(today)
  const [condition, setCondition] = useState("")
  const [finalReading, setFinalReading] = useState("")
  const [damage, setDamage] = useState<DamageLine[]>([{ description: "", amountRands: "" }])
  const { busy, error, setError, run } = useLeaseAction()
  const setLine = (index: number, key: keyof DamageLine) => (value: string) =>
    setDamage((lines) => lines.map((line, i) => (i === index ? { ...line, [key]: value } : line)))

  const submit = async () => {
    const built = inspectionBody({ inspectedOn, condition, finalReading, usageContracted: usageUnitLabel !== null, damage })
    if ("error" in built) return setError(built.error)
    await run(url, built.body)
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <TextField id="inspectedOn" label="Inspected on" type="date" required max={today} value={inspectedOn} onChange={setInspectedOn} />
        <TextField id="inspectionCondition" label="Condition" required value={condition} onChange={setCondition} />
        {usageUnitLabel && (
          <TextField id="finalReading" label={`Final reading (${usageUnitLabel})`} required inputMode="numeric" value={finalReading} onChange={setFinalReading} />
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-[var(--cf-text-secondary)]">Damage (billed on the end-of-term invoice)</h4>
        {damage.map((line, index) => (
          <div key={index} className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_12rem_auto] md:items-end">
            <TextField id={`damage-${index}-description`} label="Item" value={line.description} onChange={setLine(index, "description")} />
            <TextField id={`damage-${index}-amount`} label="Amount ex VAT (R)" inputMode="decimal" value={line.amountRands} onChange={setLine(index, "amountRands")} />
            <Button size="sm" variant="ghost" onClick={() => setDamage((lines) => lines.filter((_, i) => i !== index))} disabled={damage.length === 1}>Remove</Button>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={() => setDamage((lines) => [...lines, { description: "", amountRands: "" }])}>Add a damage item</Button>
      </div>
      <FormError message={error} />
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Recording…" : "Record the inspection"}
      </Button>
    </div>
  )
}
