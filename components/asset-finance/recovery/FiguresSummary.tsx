import { formatMoney } from "@/lib/asset-finance/format"
import type { StaffRecovery } from "./recovery-panel-data"

/** The post-sale figures once the proceeds are applied: what the loan was owed, what the sale raised after costs, and the gap either way. */
export function FiguresSummary({ figures }: { figures: NonNullable<StaffRecovery["figures"]> }) {
  const rows: [string, number | null, boolean?][] = [
    ["Settlement due", figures.settlementDueCents],
    ["Sale proceeds", figures.grossProceedsCents],
    ["Costs deducted", figures.deductedCostsCents],
    ["Net proceeds", figures.netProceedsCents, true],
    ["Costs charged to the account", figures.chargedCostsCents],
    ["Charged costs not recoverable on the account", figures.unrecoverableCostsCents > 0 ? figures.unrecoverableCostsCents : null],
    ["Shortfall", figures.shortfallCents, true],
    ["Surplus", figures.surplusCents, true],
  ]
  return (
    <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {rows.filter(([, cents]) => cents !== null).map(([label, cents, strong]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
          <dd className={`whitespace-nowrap text-sm tabular-nums text-[var(--cf-text)] ${strong ? "font-semibold" : ""}`}>{formatMoney(cents as number)}</dd>
        </div>
      ))}
    </dl>
  )
}
