"use client"

import type { ReferenceRateBasis } from "@prisma/client"
import { SelectField, TextField } from "@/components/asset-finance/register-form-controls"
import { RATE_BASIS_LABELS } from "@/lib/asset-finance/deal-labels"
import type { DealFormValues } from "@/lib/asset-finance/deal-form-body"
import type { LeaseFormValues } from "@/lib/asset-finance/lease-form-body"
import type { MaintenanceRiskModel, UsageUnit } from "@/lib/asset-finance/lease-input"
import type { RentalTiming } from "@/lib/asset-finance/lease-pricing"

// The structure half of the new-deal form for an operating or
// full-maintenance lease: no deposit, trade-in, fee or VAT deferral. Field
// errors are keyed by the API's field names.

const TIMING_LABELS: Record<RentalTiming, string> = { ARREARS: "In arrears (after each month)", ADVANCE: "In advance (first rental on the start date)" }
const RISK_LABELS: Record<MaintenanceRiskModel, string> = {
  LENDER_RISK: "Lender risk (the lender keeps a surplus and bears a deficit)",
  LESSEE_SETTLED: "Lessee settled (surplus refunded, deficit billed at the end)",
}
const UNIT_LABELS: Record<UsageUnit, string> = { HOURS: "Hours", KM: "Kilometres" }

type BaseSetter = (key: keyof DealFormValues) => (value: string) => void
type LeaseSetter = (key: keyof LeaseFormValues) => (value: string) => void

export function LeaseStructureFields(props: {
  values: DealFormValues
  lease: LeaseFormValues
  maintenance: boolean
  set: BaseSetter
  setLease: LeaseSetter
  errors: Record<string, string>
}) {
  const { values: v, lease: l, maintenance, set, setLease, errors } = props
  const unit = l.usageUnit === "HOURS" ? "hour" : "km"
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <SelectField<ReferenceRateBasis> id="rateBasis" label="Rate basis" required value={v.rateBasis}
          onChange={set("rateBasis")} options={RATE_BASIS_LABELS} error={errors.rateBasis} />
        <TextField id="ratePercent" required inputMode="decimal"
          label={v.rateBasis === "FIXED" ? "Fixed rate (% a year)" : `Margin over ${RATE_BASIS_LABELS[v.rateBasis]} (%)`}
          value={v.ratePercent} onChange={set("ratePercent")} error={errors.fixedRate ?? errors.rateMargin} />
        <TextField id="periods" label="Rentals (months)" required inputMode="numeric" value={v.periods} onChange={set("periods")}
          error={errors["preset.periods"]} />
        <TextField id="balloon" label="Residual (R)" inputMode="decimal" value={v.balloonRands} onChange={set("balloonRands")} error={errors.balloonCents} />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <SelectField<RentalTiming> id="rentalTiming" label="Rentals paid" required value={l.rentalTiming}
          onChange={setLease("rentalTiming")} options={TIMING_LABELS} error={errors.rentalTiming} />
        <div className="space-y-1.5">
          <TextField id="firstDueDate" label="First due date" type="date" required value={v.firstDueDate}
            onChange={set("firstDueDate")} error={errors.firstDueDate} />
          {l.rentalTiming === "ADVANCE" && (
            <p className="text-xs text-[var(--cf-text-muted)]">The lease starts on this date: documents are prepared for it.</p>
          )}
        </div>
        <TextField id="escalationPercent" label="Rental escalation (% a year)" inputMode="decimal" placeholder="0" value={l.escalationPercent}
          onChange={setLease("escalationPercent")} error={errors.escalationRate} />
        <TextField id="penaltyPercent" label="Early-termination penalty (%)" required inputMode="decimal" value={l.penaltyPercent}
          onChange={setLease("penaltyPercent")} error={errors.earlyTerminationPenaltyRate} />
      </div>
      {maintenance && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <TextField id="maintenanceRands" label="Maintenance a month ex VAT (R)" required inputMode="decimal" value={l.maintenanceRands}
            onChange={setLease("maintenanceRands")} error={errors.maintenanceMonthlyExclVatCents} />
          <TextField id="maintenanceEscalationPercent" label="Maintenance escalation (% a year)" required inputMode="decimal" value={l.maintenanceEscalationPercent}
            onChange={setLease("maintenanceEscalationPercent")} error={errors.maintenanceEscalationRate} />
          <SelectField<MaintenanceRiskModel> id="riskModel" label="Fund risk model" required value={l.riskModel}
            onChange={setLease("riskModel")} options={RISK_LABELS} error={errors.maintenanceRiskModel} />
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <TextField id="usageAllowance" label={`Usage allowance (${unit}s a year)`} required={maintenance} inputMode="numeric" value={l.usageAllowance}
          onChange={setLease("usageAllowance")} error={errors.usageAllowancePerYear} />
        <SelectField<UsageUnit> id="usageUnit" label="Usage unit" required={maintenance} value={l.usageUnit}
          onChange={setLease("usageUnit")} options={UNIT_LABELS} error={errors.usageUnit} />
        <TextField id="excessRateRands" label={`Excess rate per ${unit} ex VAT (R)`} required={maintenance} inputMode="decimal" value={l.excessRateRands}
          onChange={setLease("excessRateRands")} error={errors.excessRateCents} />
      </div>
      {!maintenance && (
        <p className="text-xs text-[var(--cf-text-muted)]">Contracted usage is optional on an operating lease: fill in all three usage fields or none.</p>
      )}
    </div>
  )
}
