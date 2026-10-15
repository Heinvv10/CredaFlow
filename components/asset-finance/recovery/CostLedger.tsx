import { StatusPill } from "@/components/app-shell/StatusPill"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { CostDecisionButtons } from "./CostDecisionButtons"
import { COST_ENTRY } from "./recovery-cost-adapter"
import type { StaffRecovery } from "./recovery-panel-data"
import { TREATMENT_LABELS, TREATMENT_SHORT } from "./recovery-model"

const STATUS = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected" } as const
const TONE = { PENDING: "warning", APPROVED: "success", REJECTED: "neutral" } as const
type Cost = StaffRecovery["costs"][number]

function Row({ cost }: { cost: Cost }) {
  const rejected = cost.status === "REJECTED"
  return (
    <TableRow className={rejected ? "text-[var(--cf-text-muted)] line-through" : undefined}>
      <TableCell>{formatIsoDate(cost.incurredOn)}</TableCell>
      <TableCell>{cost.label}</TableCell>
      <TableCell>{cost.supplierInvoiceRef}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(cost.netCents)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(cost.vatCents)}</TableCell>
      <TableCell className="text-right font-semibold tabular-nums">{formatMoney(cost.grossCents)}</TableCell>
      <TableCell>{TREATMENT_SHORT[cost.treatment]}</TableCell>
      <TableCell className="no-underline"><StatusPill tone={TONE[cost.status]}>{STATUS[cost.status]}</StatusPill></TableCell>
    </TableRow>
  )
}

/**
 * The recovery's cost ledger: decided costs with what is deducted from the
 * proceeds and charged to the account (approved costs only), and the costs
 * still awaiting a decision, which a different approver approves or rejects.
 */
export function CostLedger({ recoveryId, costs, pending, totals, userId, canDecide }: {
  recoveryId: string
  costs: StaffRecovery["costs"]
  pending: StaffRecovery["pendingCosts"]
  totals: StaffRecovery["costTotals"]
  userId: string
  canDecide: boolean
}) {
  if (costs.length === 0 && pending.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No cost has been recorded.</p>
  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--cf-text-muted)]">Awaiting a decision. The proceeds are applied once every cost is decided.</p>
          {pending.map((cost) => (
            <div key={cost.id} className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-[var(--cf-text)]">{cost.label} · {formatMoney(cost.grossCents)}</p>
                <StatusPill tone="warning">Pending</StatusPill>
              </div>
              <p className="text-xs text-[var(--cf-text-muted)]">
                Invoice {cost.supplierInvoiceRef} · {formatIsoDate(cost.incurredOn)} · {TREATMENT_LABELS[cost.treatment]}
                {cost.note ? ` · ${cost.note}` : ""}
              </p>
              {COST_ENTRY.canDecide({ canDecide }, cost.recordedById, userId)
                ? <CostDecisionButtons recoveryId={recoveryId} costId={cost.id} />
                : canDecide && <p className="text-xs text-[var(--cf-text-muted)]">You recorded this cost: someone else with approval rights must decide it.</p>}
            </div>
          ))}
        </div>
      )}
      {costs.length > 0 && (
        <ScrollTable maxHeight="max-h-80">
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="text-right">VAT</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Treatment</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{costs.map((cost) => <Row key={cost.id} cost={cost} />)}</TableBody>
        </ScrollTable>
      )}
      <dl className="grid grid-cols-2 gap-4">
        <div>
          <dt className="text-xs text-[var(--cf-text-muted)]">Deducted from the proceeds (approved)</dt>
          <dd className="whitespace-nowrap text-sm font-semibold tabular-nums text-[var(--cf-text)]">{formatMoney(totals.deducted)}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--cf-text-muted)]">Charged to the account (approved)</dt>
          <dd className="whitespace-nowrap text-sm font-semibold tabular-nums text-[var(--cf-text)]">{formatMoney(totals.charged)}</dd>
        </div>
      </dl>
    </div>
  )
}
