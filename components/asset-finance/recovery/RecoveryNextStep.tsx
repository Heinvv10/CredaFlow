import type { RecoveryRoute } from "@prisma/client"
import { isNcaRoute } from "@/lib/asset-finance/recovery-input"
import type { StaffRecovery } from "./recovery-panel-data"
import { LessorCancellationAssessmentForm } from "./LessorCancellationAssessmentForm"
import { StepButton } from "./StepButton"
import { ValuationForm, type SurrenderLink } from "./ValuationForm"

const base = (id: string) => `/api/asset-finance/recoveries/${id}`

/**
 * The action the recovery's status waits for: valuation, the valuation notice
 * (an s127 recovery follows its surrender's notice, so that is issued first
 * when it is not yet), listing for sale, applying the sale proceeds
 * (record_payment), the final notice, opening the outcome, closing. The sale
 * itself and the surplus refund are the sections below it.
 */
export function RecoveryNextStep({ view, surrender, today, canRecordPayment, cpaLease = false, canDecide = false }: {
  view: StaffRecovery
  surrender: (SurrenderLink & { status: string }) | null
  today: string
  canRecordPayment: boolean
  cpaLease?: boolean
  canDecide?: boolean
}) {
  const route: RecoveryRoute = view.route
  const s127 = route === "NCA_S127_SURRENDER"
  const url = (path: string) => `${base(view.id)}/${path}`
  switch (view.status) {
    case "RECOVERED":
      return <ValuationForm recoveryId={view.id} today={today} surrender={s127 ? surrender : null} />
    case "VALUED":
      if (!isNcaRoute(route)) {
        return <StepButton label="List for sale" busyLabel="Listing…" calls={[{ url: url("list"), body: {} }]} />
      }
      return (
        <div className="space-y-2">
          {s127 && <p className="text-sm text-[var(--cf-text-muted)]">The s127 notice is issued on the surrender; issuing it here moves the recovery on with it.</p>}
          <StepButton label="Issue the valuation notice" busyLabel="Issuing…" calls={[
            ...(s127 && surrender?.status === "VALUED" ? [{ url: `/api/asset-finance/surrenders/${surrender.id}/valuation-notice`, body: {} }] : []),
            { url: url("valuation-notice"), body: {} },
          ]} />
        </div>
      )
    case "VALUATION_NOTICE_ISSUED":
      return <StepButton label="List for sale" busyLabel="Listing…" calls={[{ url: url("list"), body: {} }]} />
    case "SOLD":
      return (
        <div className="space-y-2">
          {view.pendingCosts.length > 0 && (
            <p className="text-sm text-[var(--cf-warning)]">
              {view.pendingCosts.length} cost{view.pendingCosts.length === 1 ? " is" : "s are"} still pending: decide {view.pendingCosts.length === 1 ? "it" : "them"} before applying the proceeds.
            </p>
          )}
          {canRecordPayment
            ? cpaLease ? canDecide ? <LessorCancellationAssessmentForm url={url("proceeds")} /> : <p className="text-sm">A CPA cancellation assessment needs decide_asset_finance permission.</p> : <StepButton label="Apply the sale proceeds" busyLabel="Applying…" calls={[{ url: url("proceeds"), body: {} }]} />
            : <p className="text-sm text-[var(--cf-text-muted)]">Applying the sale proceeds needs the record_payment permission.</p>}
        </div>
      )
    case "PROCEEDS_APPLIED":
      return isNcaRoute(route)
        ? <StepButton label="Issue the final notice" busyLabel="Issuing…" calls={[{ url: url("final-notice"), body: {} }]} />
        : <StepButton label="Open the outcome" busyLabel="Opening…" calls={[{ url: url("outcome"), body: {} }]} />
    case "FINAL_NOTICE_ISSUED":
      return <StepButton label="Open the outcome" busyLabel="Opening…" calls={[{ url: url("outcome"), body: {} }]} />
    case "SHORTFALL_OPEN":
      return (
        <div className="space-y-2">
          <p className="text-sm text-[var(--cf-text-muted)]">A shortfall closes once the loan is settled or written off.</p>
          <StepButton label="Close recovery" busyLabel="Closing…" variant="outline" calls={[{ url: url("close"), body: {} }]} />
        </div>
      )
    default:
      return null
  }
}

