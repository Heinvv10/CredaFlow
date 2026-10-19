import Link from "next/link"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatDate } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import { DEAL_EVIDENCE_DOC_TYPES } from "@/lib/asset-finance/payout-checklist"
import type { PayoutPanel as PayoutPanelData } from "@/lib/asset-finance/payout-view"
import { statusLabel } from "@/lib/asset-finance/labels"
import { dealEvidenceUrl } from "@/lib/asset-finance/deal-evidence-url"
import { ChecklistConfirm } from "./ChecklistConfirm"
import { DealActionButton } from "./DealActionButton"
import { SuretyConsentForm } from "./SuretyConsentForm"
import { EvidenceUpload } from "./EvidenceUpload"

const link = "text-[var(--cf-brand)] underline-offset-2 hover:underline"
const PAYOUT_TONE = { PENDING_APPROVAL: "warning", APPROVED: "info", RELEASED: "success", CANCELLED: "neutral" } as const

/** The deal page's "Payout" panel (goal §4.10): checklist, payout, booking. */
export function PayoutPanel(props: { dealId: string; panel: PayoutPanelData; canManage: boolean; canDecide: boolean; userId: string; lease?: boolean }) {
  const { dealId, panel, canManage, canDecide, userId, lease } = props
  const contracted = panel.dealStatus === "CONTRACTED"
  const open = panel.checklist.filter((c) => c.required && !c.confirmedAt)
  const { payout } = panel
  const docUrl = (id: string) => dealEvidenceUrl({ dealId, entityId: panel.entityId }, id)

  return (
    <DataPanel
      title="Payout"
      description={`The supplier is owed ${formatMoney(panel.payoutAmountCents)} ${lease ? "(the cash price incl. VAT)" : "(cash price incl. VAT less deposit and trade-in)"}`
        + (panel.approvedAccount
          ? `, paid to ${panel.approvedAccount.accountHolder}, ${panel.approvedAccount.bankName} …${panel.approvedAccount.accountNumberTail}.`
          : "; the supplier has no approved bank account yet.")}
      density="loose"
    >
      {(panel.sureties ?? []).map((s) => <div key={s.signerId} className="mb-4 border-b border-[var(--cf-border-subtle)] pb-3">
        <p className="text-sm font-medium">Surety: {s.name} · {s.maritalRegime.replaceAll("_", " ")}</p>
        {canManage && contracted && !payout && <SuretyConsentForm dealId={dealId} signerId={s.signerId} maritalRegime={s.maritalRegime} documents={panel.documents} />}
      </div>)}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--cf-border-subtle)] text-left text-xs text-[var(--cf-text-muted)]">
              <th className="py-2 pr-3 font-medium">Item</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 font-medium">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {panel.checklist.map((c) => (
              <tr key={c.item} className="border-b border-[var(--cf-border-subtle)] align-top">
                <td className="py-2 pr-3 text-[var(--cf-text)]">
                  {c.label}
                  {!c.required && <p className="text-xs text-[var(--cf-text-muted)]">Not required for this asset</p>}
                </td>
                <td className="py-2 pr-3">
                  {c.confirmedAt ? (
                    <>
                      <StatusPill tone="success">Confirmed</StatusPill>
                      <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{`${c.confirmedBy ?? "—"} · ${formatDate(c.confirmedAt)}`}</p>
                    </>
                  ) : (
                    <StatusPill tone={c.required ? "warning" : "neutral"}>{c.required ? "Open" : "Optional"}</StatusPill>
                  )}
                </td>
                <td className="py-2">
                  {c.confirmedAt ? (
                    <p className="text-xs text-[var(--cf-text-secondary)]">
                      {c.evidence ? <a className={link} href={docUrl(c.evidence.id)} target="_blank" rel="noopener noreferrer">{c.evidence.fileName}</a> : "Signer records"}
                      {c.note && ` · ${c.note}`}
                    </p>
                  ) : canManage && contracted ? (
                    <ChecklistConfirm dealId={dealId} item={c.item} evidenceTypes={c.evidenceTypes} documents={panel.documents} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {panel.checklist.length === 0 && (
        <p className="text-sm text-[var(--cf-text-muted)]">The checklist is created when the deal is contracted.</p>
      )}

      {canManage && contracted && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-[var(--cf-text-secondary)]">Upload payout evidence for this deal</p>
          <EvidenceUpload dealId={dealId} docTypes={DEAL_EVIDENCE_DOC_TYPES} />
        </div>
      )}

      <div className="mt-5 space-y-3 border-t border-[var(--cf-border-subtle)] pt-4 text-sm">
        {payout ? (
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={PAYOUT_TONE[payout.status]}>{statusLabel(payout.status)}</StatusPill>
            <span className="text-[var(--cf-text)]">{formatMoney(payout.amountCents)}</span>
            <span className="text-xs text-[var(--cf-text-muted)]">
              {`Created by ${payout.createdBy}`}
              {payout.approvedBy && ` · approved by ${payout.approvedBy}`}
              {payout.dualApprovalRequired && (panel.segregationOfDuties ? " · two approvers (segregation of duties)" : " · two approvers (at or above the threshold)")}
              {payout.releasedAt && ` · released ${formatDate(payout.releasedAt)}`}
            </span>
          </div>
        ) : (
          <p className="text-[var(--cf-text-muted)]">
            {open.length > 0 ? `${open.length} required item(s) open before the payout can be created.` : "No payout yet."}
            {panel.segregationOfDuties
              ? " Every payout needs a second approver (segregation of duties)."
              : panel.dualApprovalThresholdCents !== null && ` Payouts from ${formatMoney(panel.dualApprovalThresholdCents)} need a second approver.`}
          </p>
        )}
        {canDecide && contracted && (
          <div className="flex flex-wrap gap-2">
            {!payout && open.length === 0 && (
              <DealActionButton url={`/api/asset-finance/deals/${dealId}/payout`} label="Create payout" busyLabel="Creating…" />
            )}
            {payout?.status === "PENDING_APPROVAL" && payout.createdById !== userId && (
              <DealActionButton url={`/api/asset-finance/deals/${dealId}/payout/approve`} label="Approve payout" busyLabel="Approving…" />
            )}
            {payout?.status === "APPROVED" && (
              <DealActionButton url={`/api/asset-finance/deals/${dealId}/book`} label="Book deal" busyLabel="Booking…" />
            )}
          </div>
        )}
        {payout?.status === "PENDING_APPROVAL" && payout.createdById === userId && (
          <p className="text-xs text-[var(--cf-text-muted)]">You created this payout; a second user approves it.</p>
        )}
        {panel.loan && (
          <p className="text-[var(--cf-text)]">
            Booked as loan <Link className={link} href={`/loans/${panel.loan.id}`}>{panel.loan.reference}</Link>
            {panel.taxInvoice && (
              <>
                {" · tax invoice "}
                <a className={link} href={`/api/asset-finance/tax-invoices/${panel.taxInvoice.id}`} target="_blank" rel="noopener noreferrer">{panel.taxInvoice.invoiceNumber}</a>
                {" ("}
                <a className={link} href={`/api/asset-finance/tax-invoices/${panel.taxInvoice.id}?download=1`}>download</a>
                {")"}
              </>
            )}
          </p>
        )}
      </div>
    </DataPanel>
  )
}
