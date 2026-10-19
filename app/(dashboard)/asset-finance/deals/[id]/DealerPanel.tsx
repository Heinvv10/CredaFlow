import Link from "next/link"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { formatDateTime } from "@/lib/utils"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { ENTITY_DOCUMENT_LABELS } from "@/lib/asset-finance/labels"
import { DEALER_UPLOAD_DOC_TYPES } from "@/lib/dealer/documents"
import { LINE_KIND_LABELS, RATE_SOURCE_LABELS, REVERSAL_REASON_LABELS, bpsPercent } from "@/lib/dealer/staff-labels"
import type { DealDealerPanel } from "@/lib/dealer/staff-deal-panel"
import { DealActionButton } from "./DealActionButton"
import { DealerDocumentRequestForm } from "./DealerDocumentRequestForm"

const name = (p: { name: string | null; email: string } | null) => (p ? (p.name ?? p.email) : "—")

/**
 * A dealer deal on the staff view: the handover (the staff accept runs the
 * unchanged submitDeal), the dealer's consent evidence to verify, document
 * requests, and the commission snapshot and lines. Commission is never a
 * borrower charge.
 */
export function DealerPanel({ panel, canManage }: { panel: DealDealerPanel; canManage: boolean }) {
  const dealId = panel.id
  const docTypes = Object.fromEntries(DEALER_UPLOAD_DOC_TYPES.map((t) => [t, ENTITY_DOCUMENT_LABELS[t]]))
  const accept = canManage && panel.status === "DRAFT" && panel.dealerSubmittedAt
  return (
    <DataPanel
      title={`Dealer: ${panel.dealer.name}${panel.dealer.active ? "" : " (deactivated)"}`}
      description={`Originated by ${name(panel.dealerUser)}. ${panel.dealerSubmittedAt ? `Handed to the lender ${formatDateTime(panel.dealerSubmittedAt)}.` : "Not yet submitted by the dealer."}`}
      actions={accept ? <DealActionButton url={`/api/asset-finance/deals/${dealId}/dealer-submission/accept`} label="Accept submission" busyLabel="Classifying…" /> : undefined}
      density="loose"
    >
      <div className="space-y-5 text-sm">
        <section className="space-y-2">
          <h3 className="font-semibold text-[var(--cf-text)]">People the dealer captured</h3>
          {panel.dealerPeople.length === 0 && <p className="text-[var(--cf-text-muted)]">None.</p>}
          {panel.dealerPeople.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--cf-border-subtle)] p-2">
              <p>{p.firstName} {p.lastName} · {p.email} · {p.phone}</p>
              {p.dealerContactVerifiedAt ? (
                <span className="text-xs text-[var(--cf-success)]">Contact verified by {name(p.dealerContactVerifiedBy)} {formatDateTime(p.dealerContactVerifiedAt)}</span>
              ) : canManage ? (
                <DealActionButton url={`/api/asset-finance/deals/${dealId}/dealer-people/${p.id}/verify-contact`} label="Contact details verified" busyLabel="Recording…" variant="outline" />
              ) : <span className="text-xs text-[var(--cf-warning)]">Contact not verified</span>}
            </div>
          ))}
          <p className="text-xs text-[var(--cf-text-muted)]">
            The dealer typed these details. Confirm them with the person directly, not through the dealer: until then no portal activation code or signing code is sent to them.
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="font-semibold text-[var(--cf-text)]">Consent evidence</h3>
          {panel.dealerConsentAttestations.length === 0 && <p className="text-[var(--cf-text-muted)]">The dealer has attested no consent yet.</p>}
          {panel.dealerConsentAttestations.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--cf-border-subtle)] p-2">
              <p>
                {a.client.firstName} {a.client.lastName} · attested by {name(a.dealerUser)} {formatDateTime(a.attestedAt)} ·{" "}
                {a.document.deletedAt ? <span className="text-[var(--cf-danger)]">form deleted</span> : (
                  <Link href={`/api/asset-finance/deals/${dealId}/documents/${a.document.id}`} className="text-[var(--cf-brand)] hover:underline" target="_blank">
                    {a.document.fileName}
                  </Link>
                )}
              </p>
              {a.verifiedAt ? (
                <span className="text-xs text-[var(--cf-success)]">Verified by {name(a.verifiedBy)} {formatDateTime(a.verifiedAt)}</span>
              ) : canManage ? (
                <DealActionButton url={`/api/asset-finance/deals/${dealId}/dealer-consents/${a.id}/verify`} label="Verify (records bureau consent)" busyLabel="Verifying…" variant="outline" />
              ) : <span className="text-xs text-[var(--cf-warning)]">Awaiting verification</span>}
            </div>
          ))}
          <p className="text-xs text-[var(--cf-text-muted)]">Verify against the signed form: verifying records the person&apos;s credit-bureau consent as yours.</p>
        </section>

        <section className="space-y-2">
          <h3 className="font-semibold text-[var(--cf-text)]">Document requests</h3>
          {panel.dealerDocumentRequests.length === 0 && <p className="text-[var(--cf-text-muted)]">None.</p>}
          {panel.dealerDocumentRequests.map((r) => (
            <p key={r.id}>
              {ENTITY_DOCUMENT_LABELS[r.docType]}: “{r.note}” · {name(r.requestedBy)} {formatDateTime(r.requestedAt)} ·{" "}
              {r.fulfilledAt ? <span className="text-[var(--cf-success)]">uploaded {formatDateTime(r.fulfilledAt)}</span> : <span className="text-[var(--cf-warning)]">open</span>}
            </p>
          ))}
          {canManage && !["BOOKED", "CANCELLED", "DECLINED", "REFUSED_NCA"].includes(panel.status) && (
            <DealerDocumentRequestForm dealId={dealId} docTypes={docTypes} />
          )}
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-[var(--cf-text)]">Commission (the lender&apos;s cost, not a borrower charge)</h3>
          {panel.dealerCommissionSource ? (
            <p>
              Fixed at approval {panel.dealerCommissionSnapshotAt ? formatDateTime(panel.dealerCommissionSnapshotAt) : ""} from {RATE_SOURCE_LABELS[panel.dealerCommissionSource]}:{" "}
              {bpsPercent(panel.dealerCommissionBps ?? 0)} of {formatMoney(panel.dealerCommissionBaseCents ?? 0)} + {formatMoney(panel.dealerCommissionFlatCents ?? 0)}, ex VAT.
            </p>
          ) : <p className="text-[var(--cf-text-muted)]">The rate is fixed when the deal is approved; commission is earned when it is booked.</p>}
          {panel.dealerCommissionLines.map((l) => (
            <p key={l.id}>
              {formatIsoDate(l.effectiveOn)} · {LINE_KIND_LABELS[l.kind]}{l.reason && ` (${REVERSAL_REASON_LABELS[l.reason]})`} ·{" "}
              net {formatMoney(l.netCents)} + VAT {formatMoney(l.vatCents)} = {formatMoney(l.grossCents)}
            </p>
          ))}
        </section>
      </div>
    </DataPanel>
  )
}
