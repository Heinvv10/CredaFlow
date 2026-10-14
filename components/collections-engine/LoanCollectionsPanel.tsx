import Link from "next/link"
import type { DebitMandateStatus, CollectionInstructionStatus } from "@prisma/client"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatDate, formatZAR } from "@/lib/utils"
import { loadLoanCollectionsView, type MandateWithHistory } from "@/lib/collections-engine/view.server"
import { MandateCancelButton, MandateSetupForm } from "./MandateActions"

type Tone = "neutral" | "success" | "warning" | "danger" | "info"

const MANDATE_TONE: Record<DebitMandateStatus, Tone> = {
  CREATED: "neutral", PENDING_AUTH: "info", ACTIVE: "success", REJECTED: "danger",
  EXPIRED: "warning", SUSPENDED: "danger", CANCELLED: "neutral",
}
const INSTRUCTION_TONE: Record<CollectionInstructionStatus, Tone> = {
  PENDING: "neutral", SUBMITTING: "warning", SUBMITTED: "info", REJECTED: "danger",
  CANCELLED: "neutral", PAID: "success", UNPAID: "danger", DISPUTED: "danger",
}
const label = (s: string) => s.replace(/_/g, " ").toLowerCase()

function MandateSummary({ mandate }: { mandate: MandateWithHistory }) {
  const rows: [string, string][] = [
    ["Authentication", mandate.authType.replace("_", " ")],
    ["Instalment / maximum", `${formatZAR(mandate.amountCents)} / ${formatZAR(mandate.maxAmountCents)}`],
    ["Debit day / tracking", `${mandate.debitDay} / ${mandate.trackingDays} day${mandate.trackingDays === 1 ? "" : "s"}`],
    ["First collection", formatDate(mandate.firstCollectionDate)],
    ["Account", `${mandate.bankName} …${mandate.accountNumber.slice(-4)}`],
    ["Provider reference", mandate.providerMandateRef ?? "—"],
  ]
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={MANDATE_TONE[mandate.status]}>{label(mandate.status)}</StatusPill>
        {mandate.simulated && <StatusPill tone="warning">Simulated: no bank involved</StatusPill>}
      </div>
      {mandate.statusReason && <p className="text-[var(--cf-text-muted)]">{mandate.statusReason}</p>}
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4">
          <span className="text-[var(--cf-text-muted)]">{k}</span>
          <span className="text-right font-medium text-[var(--cf-text)]">{v}</span>
        </div>
      ))}
    </div>
  )
}

function History({ mandates }: { mandates: MandateWithHistory[] }) {
  const rows = mandates.flatMap((m) => m.instructions.map((i) => ({ ...i, simulated: m.simulated })))
  if (rows.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No collections yet</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full whitespace-nowrap text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--cf-text-muted)]">
            <th className="py-1 pr-3 font-medium">Action date</th>
            <th className="py-1 pr-3 font-medium">Instalment</th>
            <th className="py-1 pr-3 text-right font-medium">Amount</th>
            <th className="py-1 pl-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => {
            const result = i.results.at(-1)
            return (
              <tr key={i.id} className="border-t border-[var(--cf-border-subtle)]">
                <td className="py-1.5">{formatDate(i.actionDate)}</td>
                <td className="py-1.5">#{i.installmentNo} (presentment {i.presentmentNo})</td>
                <td className="py-1.5 text-right tabular-nums">{formatZAR(i.amountCents)}</td>
                <td className="py-1.5 pl-3">
                  <StatusPill tone={INSTRUCTION_TONE[i.status]}>{label(i.status)}</StatusPill>
                  {result?.reasonCode && <span className="ml-2 text-xs text-[var(--cf-text-muted)]">{label(result.reasonCode)}</span>}
                  {result?.paymentId && <span className="ml-2 text-xs text-[var(--cf-success)]">receipt booked</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * DebiCheck mandate and collection history for one loan. Renders nothing while
 * the lender's collections engine is off, so the loan page is unchanged for
 * every lender that has not enabled it.
 */
export async function LoanCollectionsPanel({ tenantId, loan, canManage }: {
  tenantId: string
  loan: { id: string; applicationId: string; status: string; clientId: string | null; client: { salaryPaymentDay: number | null } | null }
  canManage: boolean
}) {
  const view = await loadLoanCollectionsView(tenantId, loan)
  if (!view) return null
  const shown = view.liveMandate ?? view.mandates[0] ?? null
  const review = view.mandates.flatMap((m) => m.instructions.flatMap((i) => i.results)).filter((r) => r.allocationError)
  const rec = view.recommendation

  return (
    <DataPanel
      title="DebiCheck collections"
      description={view.provider ? `Provider: ${view.provider}` : "No collection provider configured (Settings → Integrations)"}
      variant="default"
      density="loose"
      actions={<Link href="/collections/batches" className="text-xs text-[var(--cf-brand)] hover:underline">Batches</Link>}
    >
      <div className="space-y-5">
        {review.map((r) => (
          <InfoStrip key={r.id} variant="warning">{r.allocationError}</InfoStrip>
        ))}
        {shown && <MandateSummary mandate={shown} />}
        {shown && canManage && ["CREATED", "PENDING_AUTH", "ACTIVE", "SUSPENDED"].includes(shown.status) && (
          <MandateCancelButton loanId={loan.id} mandateId={shown.id} />
        )}
        {view.canCreate && (
          <div className="space-y-3 border-t border-[var(--cf-border-subtle)] pt-4">
            <p className="text-sm text-[var(--cf-text-muted)]">
              {rec
                ? `Recommended: debit on day ${rec.debitDay} with ${rec.trackingDays} tracking day${rec.trackingDays === 1 ? "" : "s"} (${rec.confidence.toLowerCase()} confidence, ${rec.basis === "STATEMENT_SALARY" ? `salary seen on ${rec.salaryDates.join(", ")}` : "client's declared pay day"}).`
                : view.recommendationError
                  ? `No recommendation: ${view.recommendationError}`
                  : "No salary evidence on the statements and no declared pay day: choose the debit day by hand."}
            </p>
            {canManage && <MandateSetupForm loanId={loan.id} debitDay={rec?.debitDay ?? null} trackingDays={rec?.trackingDays ?? null} />}
          </div>
        )}
        <div className="border-t border-[var(--cf-border-subtle)] pt-4">
          <History mandates={view.mandates} />
        </div>
      </div>
    </DataPanel>
  )
}
