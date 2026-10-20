import { DataPanel } from "@/components/app-shell/DataPanel"
import { formatDate, formatDateTime } from "@/lib/utils"
import type { AppRole } from "@/lib/auth-guards"
import { BANK_ACCOUNT_STATUS_LABELS } from "@/lib/asset-finance/asset-labels"
import { bankAccountTypeLabel } from "@/lib/asset-finance/labels"
import { supplierBankAccountView } from "@/lib/asset-finance/supplier-bank-view"
import type { StaffDealerDetail } from "@/lib/dealer/staff-view"
import { BankAccountDecision } from "../../suppliers/[id]/BankAccountDecision"
import { BankAccountRequestForm } from "../../suppliers/[id]/BankAccountRequestForm"

const STATUS_TONE = {
  PENDING: "text-[var(--cf-warning)]", APPROVED: "text-[var(--cf-success)]",
  REJECTED: "text-[var(--cf-danger)]", SUPERSEDED: "text-[var(--cf-text-muted)]",
} as const

function manualNote(avsResult: unknown): string | null {
  const manual = (avsResult as { manualVerification?: { note?: unknown } } | null)?.manualVerification
  return typeof manual?.note === "string" ? manual.note : null
}

/** The supplier bank-account pattern for a dealer: staff capture, a second user decides. */
export function BankAccountsPanel(props: {
  dealer: StaffDealerDetail
  user: { id: string; role: AppRole }
  canDecide: boolean
  who: (userId: string | null) => string
}) {
  const { dealer, user, canDecide, who } = props
  const hasApproved = dealer.bankAccounts.some((a) => a.status === "APPROVED")
  return (
    <DataPanel title="Bank account" description="Commission is paid only into the approved account; the dealer never sends bank details" density="loose">
      <div className="space-y-3">
        {dealer.bankAccounts.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">No bank account captured.</p>}
        {dealer.bankAccounts.map((a) => (
          <div key={a.id} className="rounded-md border border-[var(--cf-border-subtle)] p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-[var(--cf-text)]">
                {a.bankName} · <span className="font-mono">{a.branchCode}</span> · <span className="font-mono">{supplierBankAccountView(a, user.role).accountNumber}</span>
                {a.accountType && <span className="text-[var(--cf-text-muted)]"> · {bankAccountTypeLabel(a.accountType)}</span>}
              </p>
              <span className={`text-xs font-semibold ${STATUS_TONE[a.status]}`}>{BANK_ACCOUNT_STATUS_LABELS[a.status]}</span>
            </div>
            <p className="mt-1 text-xs text-[var(--cf-text-muted)]">
              Holder {a.accountHolder} · requested by {who(a.requestedById)} on {formatDate(a.createdAt)}
              {a.decidedAt && <> · decided by {who(a.decidedById)} on {formatDateTime(a.decidedAt)}</>}
            </p>
            {a.status !== "PENDING" && manualNote(a.avsResult) && (
              <p className="mt-1 text-xs text-[var(--cf-text-secondary)]">AVS not run (no juristic AVS provider). Manual verification: {manualNote(a.avsResult)}</p>
            )}
            {a.status === "PENDING" && canDecide && a.requestedById !== user.id && dealer.active && (
              <BankAccountDecision accountId={a.id} url={`/api/asset-finance/dealers/bank-accounts/${a.id}/decide`} />
            )}
            {a.status === "PENDING" && a.requestedById === user.id && (
              <p className="mt-2 text-xs text-[var(--cf-warning)]">You requested this account; a different user must approve it.</p>
            )}
          </div>
        ))}
        {dealer.active && (
          <BankAccountRequestForm supplierId={dealer.id} hasApproved={hasApproved} url={`/api/asset-finance/dealers/${dealer.id}/bank-accounts`} />
        )}
      </div>
    </DataPanel>
  )
}
