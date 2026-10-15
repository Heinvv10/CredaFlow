import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatMoney } from "@/lib/asset-finance/format"
import { ProposeSaleForm, type ValuationOption } from "./ProposeSaleForm"
import type { StaffRecovery } from "./recovery-panel-data"
import { BUYER_TYPE_LABELS, CHANNEL_LABELS, saleActions, saleNeedsApproval, screeningSummary } from "./sale-model"
import { StepButton } from "./StepButton"

const sale = (recoveryId: string, saleId: string, step: string) => `/api/asset-finance/recoveries/${recoveryId}/sales/${saleId}/${step}`

const TONE = { PENDING_APPROVAL: "warning", COMPLETED: "success", CANCELLED: "neutral" } as const
const STATUS = { PENDING_APPROVAL: "Pending", COMPLETED: "Completed", CANCELLED: "Cancelled" } as const

/**
 * The remarketing sale of the listed asset: proposals with their screening
 * result and approval state, then complete (the buyer's tax invoice), approve
 * (a second person) or cancel. `valuations` is read only while a sale can be
 * proposed.
 */
export function SalesSection({ view, userId, canManage, canDecide, valuations }: {
  view: StaffRecovery
  userId: string
  canManage: boolean
  canDecide: boolean
  valuations: ValuationOption[] | null
}) {
  const pending = view.sales.some((s) => s.status === "PENDING_APPROVAL")
  return (
    <div className="space-y-4">
      {view.sales.length === 0 && view.status !== "LISTED" && <p className="text-sm text-[var(--cf-text-muted)]">No sale has been proposed.</p>}
      {view.sales.map((s) => {
        const actions = saleActions(s, userId, { canManage, canDecide })
        return (
          <div key={s.id} className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-[var(--cf-text)]">{CHANNEL_LABELS[s.channel]} sale for {formatMoney(s.priceInclVatCents)}</p>
              <StatusPill tone={TONE[s.status]}>{STATUS[s.status]}</StatusPill>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div className="min-w-0"><dt className="text-xs text-[var(--cf-text-muted)]">Buyer</dt><dd className="break-words text-[var(--cf-text)]">{s.buyerName} ({BUYER_TYPE_LABELS[s.buyerType].toLowerCase()})</dd></div>
              <div className="min-w-0"><dt className="text-xs text-[var(--cf-text-muted)]">Highest valuation</dt><dd className="whitespace-nowrap tabular-nums text-[var(--cf-text)]">{formatMoney(s.highestValuationCents)}</dd></div>
              <div className="min-w-0"><dt className="text-xs text-[var(--cf-text-muted)]">Against the valuation</dt><dd className="text-[var(--cf-text)]">{s.belowValuation ? "Below" : "At or above"}</dd></div>
              <div className="min-w-0"><dt className="text-xs text-[var(--cf-text-muted)]">Approval</dt><dd className="text-[var(--cf-text)]">{!saleNeedsApproval(s) ? "Not needed" : s.approvedById ? "Approved" : "Needs a second person"}</dd></div>
            </dl>
            {s.belowValuationReason && <p className="whitespace-pre-wrap break-words text-sm text-[var(--cf-text-secondary)]">Reason: {s.belowValuationReason}</p>}
            <p className={`text-sm ${s.relatedPartyMatch ? "font-semibold text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"}`}>Screening: {screeningSummary(s.screeningResult)}</p>
            {actions.waitingOn && (
              <p className="text-sm text-[var(--cf-text-muted)]">
                {actions.waitingOn === "different-approver" ? "You proposed this sale: someone else with approval rights must approve it." : "It can be completed once a second person with approval rights approves it."}
              </p>
            )}
            {(actions.approve || actions.complete || actions.cancel) && (
              <div className="flex flex-wrap items-start gap-3">
                {actions.approve && <StepButton label="Approve sale" busyLabel="Approving…" calls={[{ url: sale(view.id, s.id, "approve"), body: {} }]} />}
                {actions.complete && <StepButton label="Complete sale" busyLabel="Completing…" calls={[{ url: sale(view.id, s.id, "complete"), body: {} }]} />}
                {actions.cancel && <StepButton label="Cancel sale" busyLabel="Cancelling…" variant="outline" calls={[{ url: sale(view.id, s.id, "cancel"), body: {} }]} />}
              </div>
            )}
          </div>
        )
      })}
      {canManage && view.status === "LISTED" && !pending && valuations && <ProposeSaleForm recoveryId={view.id} valuations={valuations} />}
    </div>
  )
}
