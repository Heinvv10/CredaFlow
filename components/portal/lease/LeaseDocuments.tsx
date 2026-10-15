import { StatusPill } from "@/components/app-shell/StatusPill"
import type { PortalContractDocument } from "@/lib/asset-finance/portal-contract"
import { DEAL_DOCUMENT_LABELS, SIGNER_STATE_LABELS } from "@/lib/asset-finance/signing"

const linkClass = "text-sm font-medium text-[var(--cf-brand)] underline-offset-2 hover:underline"

/**
 * The downloads of an entity lessee's lease: the statement and the signed
 * contract documents, through the entity-gated routes (the rentals' tax
 * invoices are in the rentals table). A sole proprietor's lease has no such
 * route yet: the page passes nothing and the panel is not shown.
 */
export function LeaseDocuments({ loanId, documents }: { loanId: string; documents: PortalContractDocument[] }) {
  const api = `/api/portal/asset-finance/loans/${loanId}`
  return (
    <ul className="divide-y divide-[var(--cf-border-subtle)]">
      <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <div>
          <p className="font-medium text-[var(--cf-text)]">Statement</p>
          <p className="text-xs text-[var(--cf-text-muted)]">Transactions and balance to date</p>
        </div>
        <a href={`${api}/statement?download=1`} className={linkClass}>Download</a>
      </li>
      {documents.map((d) => (
        <li key={d.signerId} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <div>
            <p className="font-medium text-[var(--cf-text)]">{DEAL_DOCUMENT_LABELS[d.document]}</p>
            <p className="text-xs text-[var(--cf-text-muted)]">Signer: {d.signerName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={d.state === "SIGNED" || d.state === "CONFIRMED" ? "success" : "warning"}>{SIGNER_STATE_LABELS[d.state]}</StatusPill>
            <a href={`${api}/documents/${d.signerId}?download=1`} className={linkClass}>Document</a>
          </div>
        </li>
      ))}
    </ul>
  )
}
