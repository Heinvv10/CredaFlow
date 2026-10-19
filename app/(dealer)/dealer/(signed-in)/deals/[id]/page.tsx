import Link from "next/link"
import { notFound } from "next/navigation"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { DealerPageTitle } from "@/components/dealer/DealerShell"
import { COMMISSION_REASON_LABELS, DEALER_STATUS_TONE, humanise, missingLabel } from "@/components/dealer/dealer-labels"
import { DealerConsentPanel } from "@/components/dealer/deal/DealerConsentPanel"
import { DealerSubmitButton } from "@/components/dealer/deal/DealerSubmitButton"
import { DealerUploadForm } from "@/components/dealer/deal/DealerUploadForm"
import { requireDealerPage } from "@/lib/dealer/page-guard"
import { loadDealerDealView } from "@/lib/dealer/deal-view"
import { DEALER_CONSENT_STATEMENT } from "@/lib/dealer/consent"
import { DEALER_UPLOAD_DOC_TYPES } from "@/lib/dealer/doc-types"
import { contractTypeLabel } from "@/lib/asset-finance/deal-labels"
import { ENTITY_DOCUMENT_LABELS } from "@/lib/asset-finance/labels"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { formatDate } from "@/lib/utils"

export const dynamic = "force-dynamic"

type Params = { params: Promise<{ id: string }> }

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex justify-between gap-4 border-b border-[var(--cf-border-subtle)] py-1.5 text-sm last:border-0">
    <dt className="text-[var(--cf-text-muted)]">{label}</dt>
    <dd className="text-right text-[var(--cf-text)]">{children}</dd>
  </div>
)

// One of the dealer's own deals, as the dealer may see it (lib/dealer/deal-view.ts):
// never the lender's decision, its reasons, bureau results or the NCA regime.
export default async function DealerDealPage({ params }: Params) {
  const actor = await requireDealerPage()
  const { id } = await params
  const deal = await loadDealerDealView(actor, id)
  if (!deal) notFound()

  const draft = deal.status === "Draft"
  const takesDocuments = deal.status !== "Declined" && deal.status !== "Cancelled"
  const openRequests = deal.documentRequests.filter((r) => !r.fulfilled)
  const consentDocuments = deal.documents.filter((d) => d.docType === "POPIA_CONSENT")

  return (
    <>
      <DealerPageTitle
        title={deal.reference}
        subtitle={`${deal.borrower} · ${deal.asset.year} ${deal.asset.make} ${deal.asset.model}`}
        actions={<StatusPill tone={DEALER_STATUS_TONE[deal.status]}>{deal.status}</StatusPill>}
      />
      <div className="mb-4 text-sm"><Link href="/dealer" className="text-[var(--cf-brand-alt)] hover:underline">All deals</Link></div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <DataPanel title="Deal">
          <dl>
            <Row label="Agreement">{contractTypeLabel(deal.contractType)}</Row>
            <Row label="Financed amount">{formatMoney(deal.financedAmountCents)}</Row>
            <Row label="Base instalment">{deal.baseInstalmentCents === null ? "—" : formatMoney(deal.baseInstalmentCents)}</Row>
            <Row label="Asset serial / PIN">{deal.asset.serialNumber}</Row>
            <Row label="Captured">{formatDate(deal.createdAt)}</Row>
            <Row label="Submitted to the lender">{deal.dealerSubmittedAt ? formatDate(deal.dealerSubmittedAt) : "Not yet"}</Row>
            {deal.booking ? <Row label="Booked">{formatIsoDate(deal.booking.bookedOn)} · {deal.booking.loanReference}</Row> : null}
          </dl>
        </DataPanel>
        <DataPanel title="Still needed" description={draft ? "Before you submit" : undefined}>
          {deal.missing.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">Nothing outstanding from you.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--cf-text)]">
              {deal.missing.map((m) => <li key={m}>{missingLabel(m)}</li>)}
            </ul>
          )}
          {draft ? <div className="mt-4"><DealerSubmitButton dealId={deal.id} /></div> : null}
        </DataPanel>
        <DataPanel title="People and consent">
          <DealerConsentPanel dealId={deal.id} people={deal.people} consentDocuments={consentDocuments} statement={DEALER_CONSENT_STATEMENT} open={draft} />
        </DataPanel>
        <DataPanel title="Documents the lender asked for">
          {deal.documentRequests.length === 0 ? <p className="text-sm text-[var(--cf-text-muted)]">No requests.</p> : (
            <ul className="space-y-3">
              {deal.documentRequests.map((r) => (
                <li key={r.id} className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="font-medium text-[var(--cf-text)]">{ENTITY_DOCUMENT_LABELS[r.docType]}</span>
                    <span className={r.fulfilled ? "text-[var(--cf-success)]" : "text-[var(--cf-warning)]"}>{r.fulfilled ? "Sent" : `Asked ${formatDate(r.requestedAt)}`}</span>
                  </div>
                  <p className="text-[var(--cf-text-secondary)]">{r.note}</p>
                  {!r.fulfilled && takesDocuments ? <DealerUploadForm dealId={deal.id} docTypes={[r.docType]} requestId={r.id} idPrefix={`request-${r.id}`} /> : null}
                </li>
              ))}
            </ul>
          )}
          {openRequests.length > 0 ? <p className="mt-3 text-xs text-[var(--cf-text-muted)]">Answer a request with its own upload so the lender sees it as sent.</p> : null}
        </DataPanel>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-5">
        <DataPanel title="Documents" description="Only the documents your team uploaded on this deal">
          {deal.documents.length === 0 ? <p className="mb-3 text-sm text-[var(--cf-text-muted)]">None yet.</p> : (
            <ul className="mb-3 space-y-1 text-sm">
              {deal.documents.map((d) => (
                <li key={d.id} className="flex justify-between gap-3">
                  <a href={`/api/dealer/deals/${deal.id}/documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="text-[var(--cf-brand-alt)] hover:underline">{d.fileName}</a>
                  <span className="text-[var(--cf-text-muted)]">{ENTITY_DOCUMENT_LABELS[d.docType]} · {formatDate(d.uploadedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          {takesDocuments ? <DealerUploadForm dealId={deal.id} docTypes={DEALER_UPLOAD_DOC_TYPES} idPrefix="deal-doc" /> : null}
        </DataPanel>
        {deal.signing.length > 0 ? (
          <DataPanel title="Signing">
            <ul className="space-y-1 text-sm">
              {deal.signing.map((s, i) => (
                <li key={`${s.document}-${s.signerRole}-${i}`} className="flex justify-between gap-3">
                  <span className="text-[var(--cf-text)]">{humanise(s.document)} · {humanise(s.signerRole)}</span>
                  <span className={s.signed ? "text-[var(--cf-success)]" : "text-[var(--cf-text-muted)]"}>{s.signed ? "Signed" : "Waiting"}</span>
                </li>
              ))}
            </ul>
          </DataPanel>
        ) : null}
        {deal.commission.length > 0 ? (
          <DataPanel title="Commission on this deal">
            <ul className="space-y-1 text-sm">
              {deal.commission.map((c, i) => (
                <li key={`${c.kind}-${i}`} className="flex justify-between gap-3">
                  <span className="text-[var(--cf-text)]">{c.kind === "EARNED" ? "Earned" : `Reversed${c.reason ? `: ${COMMISSION_REASON_LABELS[c.reason] ?? humanise(c.reason)}` : ""}`} · {formatIsoDate(c.effectiveOn)}</span>
                  <span className="tabular-nums text-[var(--cf-text)]">{formatMoney(c.grossCents)}</span>
                </li>
              ))}
            </ul>
          </DataPanel>
        ) : null}
      </div>
    </>
  )
}
