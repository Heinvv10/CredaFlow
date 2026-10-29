"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DECLINE_CATEGORY_LABELS } from "@/lib/applications/decline-category"
import type { RuleDef, RuleOutcome } from "@/lib/decisioning/types"
import { ConditionTree } from "./ConditionTree"
import { controlClass, type FactOption } from "./types"

const OUTCOME_LABELS: Record<RuleOutcome, string> = {
  KNOCK_OUT: "Knock-out: decline",
  REFER: "Refer to staff",
  LIMIT_CAP: "Cap the amount (refer above it)",
}
// Categories with wording the client can be shown (not OTHER or WITHDRAWN).
const CATEGORIES = Object.entries(DECLINE_CATEGORY_LABELS).filter(([key]) => key !== "OTHER" && key !== "WITHDRAWN")

interface Props {
  rule: RuleDef
  index: number
  facts: FactOption[]
  disabled?: boolean
  onChange: (rule: RuleDef) => void
  onRemove: () => void
}

/** One rule: name, outcome, the reason code every decision it drives carries, and its condition. */
export function RuleRow({ rule, index, facts, disabled, onChange, onRemove }: Props) {
  const setOutcome = (outcome: RuleOutcome) => {
    const { declineCategory: _c, limitCapCents: _l, ...rest } = rule
    onChange({ ...rest, outcome, ...(outcome === "KNOCK_OUT" ? { declineCategory: "POLICY" as const } : {}), ...(outcome === "LIMIT_CAP" ? { limitCapCents: 0 } : {}) })
  }
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-lg border border-[var(--cf-border-subtle)] p-4">
      <legend className="px-1 text-sm font-semibold">Rule {index + 1}</legend>
      <div className="grid gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor={`rule-name-${index}`}>Name</Label>
          <Input id={`rule-name-${index}`} value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`rule-id-${index}`}>Rule id</Label>
          <Input id={`rule-id-${index}`} value={rule.id} onChange={(e) => onChange({ ...rule, id: e.target.value.toLowerCase() })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`rule-code-${index}`}>Reason code</Label>
          <Input id={`rule-code-${index}`} value={rule.reasonCode} onChange={(e) => onChange({ ...rule, reasonCode: e.target.value.toUpperCase() })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`rule-outcome-${index}`}>When it matches</Label>
          <select id={`rule-outcome-${index}`} className={`${controlClass} w-full`} value={rule.outcome} onChange={(e) => setOutcome(e.target.value as RuleOutcome)}>
            {Object.entries(OUTCOME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>
      {rule.outcome === "KNOCK_OUT" && (
        <div className="space-y-1 md:w-1/2">
          <Label htmlFor={`rule-cat-${index}`}>Reason shown to the client</Label>
          <select id={`rule-cat-${index}`} className={`${controlClass} w-full`} value={rule.declineCategory ?? "POLICY"} onChange={(e) => onChange({ ...rule, declineCategory: e.target.value as RuleDef["declineCategory"] })}>
            {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      )}
      {rule.outcome === "LIMIT_CAP" && (
        <div className="space-y-1 md:w-1/2">
          <Label htmlFor={`rule-cap-${index}`}>Largest principal allowed (cents)</Label>
          <Input id={`rule-cap-${index}`} type="number" min={0} value={rule.limitCapCents ?? 0} onChange={(e) => onChange({ ...rule, limitCapCents: Number(e.target.value) })} />
        </div>
      )}
      <div className="space-y-1">
        <Label>Applies when</Label>
        <ConditionTree node={rule.when} facts={facts} onChange={(when) => onChange({ ...rule, when })} />
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove rule</Button>
    </fieldset>
  )
}
