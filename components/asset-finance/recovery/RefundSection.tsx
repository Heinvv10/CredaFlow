import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatMoney } from "@/lib/asset-finance/format"
import { refundActions } from "./refund-model"
import { RefundForm } from "./RefundForm"
import type { StaffRecovery } from "./recovery-panel-data"
import { StepButton } from "./StepButton"

const url = (id: string, step: string) => `/api/asset-finance/recoveries/${id}/refund/${step}`
const STATUS = { PENDING_APPROVAL: "Awaiting approval", APPROVED: "Approved", RELEASED: "Released" } as const

/** The surplus held for the debtor: create the refund, a second person approves it, an approver releases it (which closes the recovery). The account is shown to staff who manage the refund as holder, bank, branch and the last 4 digits, with the bank's verification document; the full number never reaches the page. */
export function RefundSection({ view, userId, canManage, canDecide }: { view: StaffRecovery; userId: string; canManage: boolean; canDecide: boolean }) {
  const refund = view.refund
  const actions = refundActions(refund, userId, { canManage, canDecide })
  return (
    <div className="space-y-4">
      {view.status === "SURPLUS_HELD" && (
        <p className="text-sm text-[var(--cf-text-muted)]">
          The sale left a surplus of {formatMoney(view.figures?.surplusCents ?? 0)} for the debtor. It is refunded to a verified bank account, created by one person, approved by a second and released by a third.
        </p>
      )}
      {refund && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3 text-sm">
          <span className="font-semibold tabular-nums text-[var(--cf-text)]">{formatMoney(refund.amountCents)}</span>
          <StatusPill tone={refund.status === "RELEASED" ? "success" : "warning"}>{STATUS[refund.status]}</StatusPill>
          {refund.status === "PENDING_APPROVAL" && canDecide && refund.createdById === userId && (
            <span className="text-[var(--cf-text-muted)]">You created it: someone else must approve it.</span>
          )}
          {refund.status === "APPROVED" && canDecide && (refund.approvedById === userId || refund.createdById === userId) && (
            <span className="text-[var(--cf-text-muted)]">You {refund.createdById === userId ? "created" : "approved"} it: a third person must release it.</span>
          )}
        </div>
      )}
      {refund?.bank && <RefundAccount bank={refund.bank} />}
      {actions.approve && <StepButton label="Approve refund" busyLabel="Approving…" calls={[{ url: url(view.id, "approve"), body: {} }]} />}
      {actions.release && <StepButton label="Release refund" busyLabel="Releasing…" calls={[{ url: url(view.id, "release"), body: {} }]} />}
      {actions.create && <RefundForm recoveryId={view.id} />}
    </div>
  )
}

const link = "text-[var(--cf-text-secondary)] underline underline-offset-2 hover:text-[var(--cf-text)]"

function RefundAccount({ bank }: { bank: NonNullable<NonNullable<StaffRecovery["refund"]>["bank"]> }) {
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
        {[
          ["Account holder", bank.accountHolder],
          ["Bank", bank.bankName],
          ["Branch code", bank.branchCode],
          ["Account", `ending ····${bank.accountNumberLast4}`],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
            <dd className="break-words text-[var(--cf-text)]">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm">
        <a className={link} href={bank.verificationDocumentUrl} target="_blank" rel="noopener noreferrer">Open bank verification document</a>
        {" · "}
        <a className={link} href={`${bank.verificationDocumentUrl}?download=1`}>Download</a>
      </p>
    </div>
  )
}
