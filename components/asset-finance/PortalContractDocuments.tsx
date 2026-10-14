import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatDate } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import { DEAL_DOCUMENT_LABELS, SIGNER_STATE_LABELS } from "@/lib/asset-finance/signing"
import type { PortalContractView } from "@/lib/asset-finance/portal-contract"

// The contract's downloads: statement, tax invoice and the deal documents the
// client may read. Every link is a portal API route that re-checks the
// client's authority and writes a DocumentAccessLog row before serving bytes.

const linkClass = "text-sm font-medium text-[var(--cf-brand)] underline-offset-2 hover:underline"

export function PortalContractDocuments({ view }: { view: PortalContractView }) {
  const api = `/api/portal/asset-finance/loans/${view.loan.id}`
  return (
    <ul className="divide-y divide-[var(--cf-border-subtle)]">
      <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <div>
          <p className="font-medium text-[var(--cf-text)]">Statement</p>
          <p className="text-xs text-[var(--cf-text-muted)]">Transactions and balance to date</p>
        </div>
        <a href={`${api}/statement?download=1`} className={linkClass}>Download</a>
      </li>
      <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <div>
          <p className="font-medium text-[var(--cf-text)]">Tax invoice</p>
          <p className="text-xs text-[var(--cf-text-muted)]">
            {view.taxInvoice
              ? `${view.taxInvoice.invoiceNumber} · ${formatDate(view.taxInvoice.issueDate)} · ${formatMoney(view.taxInvoice.totalInclVatCents)} incl. VAT`
              : "No tax invoice has been issued for this contract."}
          </p>
        </div>
        {view.taxInvoice && <a href={`${api}/tax-invoice?download=1`} className={linkClass}>Download</a>}
      </li>
      {view.documents.map((d) => (
        <li key={d.signerId} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <div>
            <p className="font-medium text-[var(--cf-text)]">{DEAL_DOCUMENT_LABELS[d.document]}</p>
            <p className="text-xs text-[var(--cf-text-muted)]">Signer: {d.signerName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={d.state === "SIGNED" || d.state === "CONFIRMED" ? "success" : "warning"}>{SIGNER_STATE_LABELS[d.state]}</StatusPill>
            <a href={`${api}/documents/${d.signerId}?download=1`} className={linkClass}>Document</a>
            {d.scanDocumentId && (
              <a href={`/api/portal/asset-finance/entities/${view.entity.id}/documents/${d.scanDocumentId}?download=1`} className={linkClass}>
                Signed scan
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
