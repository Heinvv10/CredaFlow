"use client"

import type { ReferenceRateBasis } from "@prisma/client"
import { SelectField, TextField } from "@/components/asset-finance/register-form-controls"
import { PRESET_LABELS, RATE_BASIS_LABELS } from "@/lib/asset-finance/deal-labels"
import type { DealFormValues } from "@/lib/asset-finance/deal-form-body"
import type { StructurePresetName } from "@/lib/asset-finance/deal-input"

// The structure half of the new-deal form: amounts, rate and the preset with
// its parameters. Field errors are keyed by the API's field names.

type Setter = (key: keyof DealFormValues) => (value: string) => void

export function DealStructureFields(props: { values: DealFormValues; set: Setter; errors: Record<string, string> }) {
  const { values: v, set, errors } = props
  const presetError = errors.preset ?? errors["preset.kind"]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <TextField id="deposit" label="Deposit (R)" inputMode="decimal" value={v.depositRands} onChange={set("depositRands")} error={errors.depositCents} />
        <TextField id="tradeIn" label="Trade-in (R)" inputMode="decimal" value={v.tradeInRands} onChange={set("tradeInRands")} error={errors.tradeInCents} />
        <TextField id="fees" label="Financed fees (R)" inputMode="decimal" value={v.feesRands} onChange={set("feesRands")} error={errors.financedFeesCents} />
        <TextField id="balloon" label="Balloon (R)" inputMode="decimal" value={v.balloonRands} onChange={set("balloonRands")} error={errors.balloonCents} />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <SelectField<ReferenceRateBasis> id="rateBasis" label="Rate basis" required value={v.rateBasis}
          onChange={set("rateBasis")} options={RATE_BASIS_LABELS} error={errors.rateBasis} />
        <TextField id="ratePercent" required inputMode="decimal"
          label={v.rateBasis === "FIXED" ? "Fixed rate (% a year)" : `Margin over ${RATE_BASIS_LABELS[v.rateBasis]} (%)`}
          value={v.ratePercent} onChange={set("ratePercent")} error={errors.fixedRate ?? errors.rateMargin} />
        <TextField id="firstDueDate" label="First due date" type="date" required value={v.firstDueDate}
          onChange={set("firstDueDate")} error={errors.firstDueDate} />
        <TextField id="vatDeferral" label="VAT repaid in period (optional)" inputMode="numeric" value={v.vatDeferralPeriod}
          onChange={set("vatDeferralPeriod")} error={errors.vatDeferralPeriodIndex} />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <SelectField<StructurePresetName> id="preset" label="Structure" required value={v.preset}
          onChange={set("preset")} options={PRESET_LABELS} error={presetError} />
        <TextField id="periods" label="Months" required inputMode="numeric" value={v.periods} onChange={set("periods")}
          error={errors["preset.periods"]} />
        {v.preset === "SKIP_N" && (
          <TextField id="skipFirst" label="Months with no payment" inputMode="numeric" value={v.skipFirst} onChange={set("skipFirst")} />
        )}
        {v.preset === "ANNUAL_SEASONAL" && (
          <>
            <TextField id="seasonMonths" label="Season months (1-12)" placeholder="3, 4, 5" value={v.seasonMonths}
              onChange={set("seasonMonths")} error={errors["preset.seasonMonths"]} />
            <TextField id="seasonWeight" label="Season weight" placeholder="3" inputMode="decimal"
              value={v.seasonWeight} onChange={set("seasonWeight")} />
            <TextField id="offWeight" label="Off-season weight" placeholder="0.5" inputMode="decimal"
              value={v.offWeight} onChange={set("offWeight")} />
          </>
        )}
        {v.preset === "BIANNUAL" && (
          <TextField id="months" label="The two paying months (1-12)" placeholder="3, 9" value={v.months}
            onChange={set("months")} error={errors["preset.months"]} />
        )}
        {v.preset === "STEP_UP" && (
          <TextField id="steps" label="Steps (from month : weight)" placeholder="13:1.5, 25:2" value={v.steps}
            onChange={set("steps")} error={errors["preset.steps"]} />
        )}
      </div>
    </div>
  )
}
