"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { MoneyField } from "@/components/asset-finance/MoneyField"
import { randsToCents } from "@/lib/asset-finance/money-input"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import type { DealFinancialsView } from "@/lib/asset-finance/deal-detail"

// The credit memo inputs (decision 2a.3). Rands are typed and sent as whole
// cents; EBITDA may be negative. The API computes DSCR and gearing. A deal
// past decision (or a user who may not manage it) sees the memo read-only.

const MONEY = [
  ["turnoverCents", "Turnover (R)"],
  ["ebitdaCents", "EBITDA (R)"],
  ["totalAssetsCents", "Total assets (R)"],
  ["totalLiabilitiesCents", "Total liabilities (R)"],
  ["existingDebtServiceCents", "Existing annual debt service (R)"],
  ["avgMonthlyCreditsCents", "Average monthly bank credits (R)"],
] as const
type MoneyKey = (typeof MONEY)[number][0]

const toRands = (cents: number) => (cents / 100).toFixed(2)

function CreditMemoView({ current }: { current: DealFinancialsView | null }) {
  if (!current) return <p className="text-sm text-[var(--cf-text-muted)]">No credit memo was recorded.</p>
  const items: Array<[string, string]> = [
    ["AFS / accounts period end", formatIsoDate(current.periodEnd)],
    ...MONEY.map(([key, label]): [string, string] => [label.replace(" (R)", ""), formatMoney(current[key])]),
    ["Returned debits (count)", String(current.returnedDebitsCount)],
    ["Notes", current.notes ?? "—"],
  ]
  return (
    <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 md:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
          <dd className="font-medium text-[var(--cf-text)]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function CreditMemoForm({ dealId, current, editable }: { dealId: string; current: DealFinancialsView | null; editable: boolean }) {
  if (!editable) return <CreditMemoView current={current} />
  return <CreditMemoEditor dealId={dealId} current={current} />
}

function CreditMemoEditor({ dealId, current }: { dealId: string; current: DealFinancialsView | null }) {
  const router = useRouter()
  const [values, setValues] = useState<Record<MoneyKey, string>>(() =>
    Object.fromEntries(MONEY.map(([key]) => [key, current ? toRands(current[key]) : ""])) as Record<MoneyKey, string>,
  )
  const [periodEnd, setPeriodEnd] = useState(current?.periodEnd ?? "")
  const [returnedDebits, setReturnedDebits] = useState(current ? String(current.returnedDebitsCount) : "0")
  const [notes, setNotes] = useState(current?.notes ?? "")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const body: Record<string, unknown> = { periodEnd, notes: notes.trim() || null, returnedDebitsCount: Number(returnedDebits) }
    const local: Record<string, string> = {}
    for (const [key] of MONEY) {
      const raw = values[key].trim()
      const negative = key === "ebitdaCents" && raw.startsWith("-")
      const cents = randsToCents(negative ? raw.slice(1) : raw)
      if (cents === null) local[key] = "An amount in rand, e.g. 1250000.00"
      else body[key] = negative ? -cents : cents
    }
    if (!/^\d+$/.test(returnedDebits)) local.returnedDebitsCount = "A whole number"
    if (Object.keys(local).length > 0) {
      setFields(local)
      setError("Check the highlighted fields")
      return
    }
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson(`/api/asset-finance/deals/${dealId}/financials`, "PUT", body)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <TextField id="periodEnd" label="AFS / accounts period end" type="date" required value={periodEnd} onChange={setPeriodEnd}
          error={fields.periodEnd} />
        {MONEY.map(([key, label]) => (
          <MoneyField key={key} id={key} label={label} required allowNegative={key === "ebitdaCents"} value={values[key]}
            onChange={(v) => setValues((prev) => ({ ...prev, [key]: v }))} error={fields[key]} />
        ))}
        <TextField id="returnedDebitsCount" label="Returned debits (count)" required inputMode="numeric" value={returnedDebits}
          onChange={setReturnedDebits} error={fields.returnedDebitsCount} />
        <TextField id="notes" label="Notes" value={notes} onChange={setNotes} error={fields.notes} />
      </div>
      <Button size="sm" onClick={save} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {saving ? "Saving…" : current ? "Update credit memo" : "Record credit memo"}
      </Button>
    </div>
  )
}
