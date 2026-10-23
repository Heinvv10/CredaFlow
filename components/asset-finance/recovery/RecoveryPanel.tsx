import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { sastCalendarDate } from "@/lib/date/sast"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { AddCostForm } from "./AddCostForm"
import { CostLedger } from "./CostLedger"
import { RecordRecoveryForm } from "./RecordRecoveryForm"
import { COST_ENTRY } from "./recovery-cost-adapter"
import { canWithdraw, costsOpen, hasNextStep, ROUTE_LABELS, STATUS_LABELS, VALUATION_SOURCE_LABELS } from "./recovery-model"
import { loadCostFormData, loadGuideReference, loadRecoveryPanelData, loadSaleValuations } from "./recovery-panel-data"
import { RecoveryDocuments } from "./RecoveryDocuments"
import { RecoveryNextStep } from "./RecoveryNextStep"
import { RecoveryStepper } from "./RecoveryStepper"
import { WithdrawRecovery } from "./WithdrawRecovery"
import { WithdrawnHistory } from "./WithdrawnHistory"
import { FiguresSummary } from "./FiguresSummary"
import { RefundSection } from "./RefundSection"
import { SalesSection } from "./SalesSection"
import { LastKnownPosition } from "../telematics/LastKnownPosition"
import { PositionTrail } from "../telematics/PositionTrail"
import { positionRefusalFor } from "@/lib/telematics/position-purpose"

/**
 * The recovery of an asset-finance loan on the staff loan page: the route's
 * stepper, valuation, notices, cost ledger and the withdraw action
 * (lib/asset-finance/recovery-*.ts). Server component: it reads the recovery
 * through loadStaffRecoveryView; the forms are client components posting to
 * app/api/asset-finance/. Shown when the loan has a recovery, or when staff
 * can record one (a non-NCA hand-over, or an NCA s127 surrender). An s131 or
 * court-order recovery comes from the legal matter's recovered step.
 * `canManage` / `canDecide` are manage_asset_finance / decide_asset_finance.
 * `canViewPosition` (view_asset_position) adds the logged "Show last known
 * position": for a live recovery (context RECOVERY), or before one exists for
 * a loan in default (context DEFAULT). Where the reveal would be refused the
 * panel shows the reason instead of the button (lib/telematics/position-purpose.ts).
 */

const subheading = "mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cf-text-muted)]"

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="break-words text-sm text-[var(--cf-text)]">{children}</dd>
    </div>
  )
}

export async function RecoveryPanel({ tenantId, loanId, userId, canManage, canDecide, canRecordPayment, canViewPosition = false }: {
  tenantId: string
  loanId: string
  userId: string
  canManage: boolean
  canDecide: boolean
  canRecordPayment: boolean
  canViewPosition?: boolean
}) {
  const data = await loadRecoveryPanelData(tenantId, loanId, { bankDetails: canManage })
  if (data.kind === "none") return null
  const today = sastCalendarDate(new Date())

  if (data.kind === "record") {
    const form = canManage && data.canRecord
    if (!form && data.withdrawn.length === 0 && !canViewPosition) return null
    return (
      <DataPanel title="Recovery" description={form ? "The asset is back in the lender's hands: value it, notify, remarket and settle the account." : "Recovery of the asset"} density="loose">
        <div className="space-y-4">
          {canViewPosition && <LastKnownPosition loanId={loanId} context="DEFAULT" refusal={await positionRefusalFor(tenantId, loanId, "DEFAULT")} />}
          <WithdrawnHistory withdrawn={data.withdrawn} />
          {form && (
            <RecordRecoveryForm loanId={loanId} lease={data.lease} today={today} surrenders={data.surrenders}
              route={data.regime === "NCA" ? "NCA_S127_SURRENDER" : "NON_NCA_VOLUNTARY"} />
          )}
        </div>
      </DataPanel>
    )
  }

  const { view, surrender } = data
  const live = view.status !== "CLOSED" && view.status !== "WITHDRAWN"
  const addCost = COST_ENTRY.canEnter({ canManage }) && costsOpen(view.status)
  const costForm = addCost ? await loadCostFormData(tenantId, loanId) : null
  const proposing = canManage && view.status === "LISTED" && !view.sales.some((s) => s.status === "PENDING_APPROVAL")
  const valuations = proposing ? await loadSaleValuations(tenantId, view.assetId) : null
  const guideReference = await loadGuideReference(tenantId, view.assetId)

  return (
    <DataPanel title="Recovery" description={ROUTE_LABELS[view.route]} density="loose"
      actions={<StatusPill tone={view.status === "WITHDRAWN" ? "neutral" : view.status === "SHORTFALL_OPEN" ? "danger" : view.status === "CLOSED" ? "success" : "warning"}>{STATUS_LABELS[view.status]}</StatusPill>}>
      <div className="space-y-6">
        <RecoveryStepper route={view.route} status={view.status} />
        {canViewPosition && live && <LastKnownPosition loanId={loanId} context="RECOVERY" refusal={await positionRefusalFor(tenantId, loanId, "RECOVERY")} />}
        {canViewPosition && live && <PositionTrail loanId={loanId} context="RECOVERY" refusal={await positionRefusalFor(tenantId, loanId, "RECOVERY")} />}
        {view.status === "WITHDRAWN" && (
          <p className="rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3 text-sm text-[var(--cf-text)]">
            <span className="text-[var(--cf-text-muted)]">Withdrawn: </span>{view.withdrawnReason}
          </p>
        )}

        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Item label="Recovered on">{formatIsoDate(view.recoveredOn)}</Item>
          <Item label="Location">{view.location}</Item>
          <Item label="Condition">{view.condition}</Item>
          <Item label="Valuation">
            {view.valuation
              ? `${formatMoney(view.valuation.amountCents)} · ${VALUATION_SOURCE_LABELS[view.valuation.source]}, ${formatIsoDate(view.valuation.valuedOn)}`
              : "Not valued"}
          </Item>
          {guideReference && <Item label="Guide reference (not an independent valuation)">{guideReference}</Item>}
          {view.freeze.from && view.freeze.until && (
            <Item label="Charges frozen">{formatIsoDate(view.freeze.from)} to {formatIsoDate(view.freeze.until)}</Item>
          )}
        </dl>

        {canManage && live && hasNextStep(view.status) && (
          <section>
            <h3 className={subheading}>Next step</h3>
            <RecoveryNextStep view={view} surrender={surrender} today={today} canRecordPayment={canRecordPayment} cpaLease={data.cpaLease} canDecide={canDecide} />
          </section>
        )}

        {(view.status === "LISTED" || view.sales.length > 0) && (
          <section>
            <h3 className={subheading}>Sale</h3>
            <SalesSection view={view} userId={userId} canManage={canManage} canDecide={canDecide} valuations={valuations} />
          </section>
        )}

        {view.cancellationBasis && <section>
          <h3 className={subheading}>Reasoned cancellation assessment</h3>
          <p className="text-sm text-[var(--cf-text)]">{view.cancellationBasis}</p>
        </section>}
        {view.figures && (
          <section>
            <h3 className={subheading}>Account after the sale</h3>
            <FiguresSummary figures={view.figures} />
          </section>
        )}

        {(view.status === "SURPLUS_HELD" || view.refund) && (
          <section>
            <h3 className={subheading}>Surplus refund</h3>
            <RefundSection view={view} userId={userId} canManage={canManage} canDecide={canDecide} />
          </section>
        )}

        <section>
          <h3 className={subheading}>Notices and statements</h3>
          <RecoveryDocuments view={view} />
        </section>

        <section>
          <h3 className={subheading}>Costs</h3>
          <CostLedger recoveryId={view.id} costs={view.costs} pending={view.pendingCosts} totals={view.costTotals} userId={userId} canDecide={canDecide} />
        </section>

        {costForm && (
          <section>
            <h3 className={subheading}>Add a cost</h3>
            <AddCostForm recoveryId={view.id} route={view.route} today={today} {...costForm} />
          </section>
        )}

        {canManage && canWithdraw(view.status) && <WithdrawRecovery recoveryId={view.id} />}
      </div>
    </DataPanel>
  )
}
