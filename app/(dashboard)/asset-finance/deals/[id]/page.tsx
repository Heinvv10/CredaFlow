import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { FormError } from "@/components/asset-finance/register-form-controls"
import { ScheduleTable } from "@/components/asset-finance/ScheduleTable"
import { canDo } from "@/lib/auth-guards"
import { formatDate } from "@/lib/utils"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { dealDecisionNote } from "@/lib/asset-finance/labels"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"
import { MEMO_EDITABLE_STATUSES } from "@/lib/asset-finance/deal-financials"
import { DEAL_STATUS_TONE, dealStatusLabel, ratePercent } from "@/lib/asset-finance/deal-labels"
import { BureauTable, ClassificationPanel, DealSummaryPanel } from "./DealSummaryPanels"
import { CreditMemoForm } from "./CreditMemoForm"
import { DealActionButton } from "./DealActionButton"
import { BureauChecksButton } from "./BureauChecksButton"
import { DecidePanel } from "./DecidePanel"
import { OverrideDecision } from "./OverrideDecision"
import { NcaOverrideRequest } from "./NcaOverrideRequest"
import { SigningPanel } from "./SigningPanel"
import { loadStaffSigningPanel } from "@/lib/asset-finance/signing-view"
import { loadPayoutPanel } from "@/lib/asset-finance/payout-view"
import { PayoutPanel } from "./PayoutPanel"
import { CancelDealForm } from "./CancelDealForm"
import { CANCELLABLE_DEAL_STATUSES } from "@/lib/asset-finance/deal-cancel"

const DECIDABLE = ["SUBMITTED", "REFERRED"]
const DECISION_LABELS: Record<string, string> = { APPROVE: "Approved", DECLINE: "Declined", REFER: "Referred" }
const OPEN_FOR_CHECKS = ["DRAFT", "SUBMITTED", "REFERRED"]
const SIGNING_STATUSES = ["APPROVED", "CONTRACTED", "BOOKED"]
const PAYOUT_STATUSES = ["CONTRACTED", "BOOKED"]
// Closed after a decision: the panel states the end state under the decision.
const CLOSED_AFTER_DECISION = ["CANCELLED", "BOOKED"]

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, tenantId, canManage } = await requireAssetFinanceStaffPage()
  const canDecide = canDo(user.role, "decide_asset_finance")
  const { id } = await params
  const deal = await loadDealDetail(tenantId, id)
  if (!deal) notFound()
  const { schedule, financials } = deal
  const signing = SIGNING_STATUSES.includes(deal.status) ? await loadStaffSigningPanel(tenantId, id) : null
  const payout = PAYOUT_STATUSES.includes(deal.status) ? await loadPayoutPanel(tenantId, id) : null

  const submit = canManage && deal.status === "DRAFT"
    ? <DealActionButton url={`/api/asset-finance/deals/${id}/submit`} label="Submit deal" busyLabel="Classifying…" />
    : null

  return (
    <>
      <Header
        title={`${deal.application.reference} · ${deal.entity.legalName}`}
        subtitle={`${deal.asset.description} · created ${formatDate(deal.createdAt)}`}
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Deals", href: "/asset-finance/deals" }, { label: deal.application.reference }]}
        actions={
          <div className="flex items-center gap-3">
            <StatusPill tone={DEAL_STATUS_TONE[deal.status]}>{dealStatusLabel(deal.status)}</StatusPill>
            {submit}
          </div>
        }
      />
      <div className="space-y-5 p-4 lg:p-8">
        <DealSummaryPanel deal={deal} />

        <ClassificationPanel deal={deal}>
          {canDecide && deal.awaitingRegimeApproval && deal.pendingOverrideId && (
            <OverrideDecision overrideId={deal.pendingOverrideId} />
          )}
          <NcaOverrideRequest application={deal.application} pendingOverride={deal.pendingOverrideId !== null} canManage={canManage} />
        </ClassificationPanel>

        <DataPanel
          title="Schedule"
          description={schedule.ok
            ? `Indicative from ${formatIsoDate(schedule.startDate)} at ${ratePercent(schedule.rate.annualRate)} a year; the contract schedule is solved from the start date chosen when the documents are prepared`
            : undefined}
        >
          {schedule.ok ? <ScheduleTable {...schedule.result} /> : <FormError message={`The schedule cannot be solved: ${schedule.error}`} />}
        </DataPanel>

        <DataPanel
          title="Credit memo"
          description={financials
            ? `DSCR ${financials.dscr ?? "n/a"} · gearing ${financials.gearing ?? "n/a"} · avg credits ${formatMoney(financials.avgMonthlyCreditsCents)}/month`
            : "DSCR = EBITDA ÷ (existing annual debt service + this deal's annualised instalments); gearing = liabilities ÷ assets"}
          density="loose"
        >
          <CreditMemoForm dealId={id} current={financials} editable={canManage && MEMO_EDITABLE_STATUSES.includes(deal.status)} />
        </DataPanel>

        <DataPanel
          title="Director and trustee bureau checks"
          actions={canManage && OPEN_FOR_CHECKS.includes(deal.status)
            ? <BureauChecksButton dealId={id} />
            : undefined}
        >
          <BureauTable deal={deal} />
        </DataPanel>

        <DataPanel title="Credit decision" density="loose">
          {deal.decision.decision && (
            <div className="mb-4 text-sm">
              <p className="font-semibold text-[var(--cf-text)]">
                {DECISION_LABELS[deal.decision.decision] ?? deal.decision.decision} on {deal.decision.decidedAt ? formatDate(deal.decision.decidedAt) : "—"}
              </p>
              <ul className="ml-5 list-disc text-[var(--cf-text-secondary)]">
                {deal.decision.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          )}
          {canDecide && DECIDABLE.includes(deal.status) ? (
            <DecidePanel dealId={id} />
          ) : (
            (!deal.decision.decision || CLOSED_AFTER_DECISION.includes(deal.status)) && (
              <p className="text-sm text-[var(--cf-text-muted)]">{dealDecisionNote(deal.status)}</p>
            )
          )}
        </DataPanel>

        {signing && <SigningPanel dealId={id} panel={signing} canManage={canManage} userId={user.id} />}

        {payout && <PayoutPanel dealId={id} panel={payout} canManage={canManage} canDecide={canDecide} userId={user.id} />}

        {canDecide && CANCELLABLE_DEAL_STATUSES.includes(deal.status) && (
          <DataPanel
            title="Cancel the deal"
            description="Cancels an unreleased payout and the application, and releases the asset so it can be financed on a new deal."
            density="loose"
          >
            <CancelDealForm dealId={id} />
          </DataPanel>
        )}
      </div>
    </>
  )
}
