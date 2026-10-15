import { DataPanel } from "@/components/app-shell/DataPanel"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { statusLabel } from "@/lib/asset-finance/labels"
import { canSubmitClaim, claimActions } from "@/lib/asset-finance/lease-staff-actions"
import { ClaimActions } from "./ClaimActions"
import { ClaimSubmitForm, type ClaimOptions } from "./ClaimSubmitForm"
import type { FundView } from "./lease-staff-data"

// The maintenance fund of a full-maintenance lease: its balance, the claims
// with their approval steps, and the movements the balance is derived from.

const MOVEMENT_LABELS = { CONTRIBUTION: "Rental contribution", CLAIM: "Claim paid", SETTLEMENT_REFUND: "Refund to lessee", SETTLEMENT_BILLED: "Deficit billed" } as const
const RISK_LABELS = { LENDER_RISK: "Lender risk", LESSEE_SETTLED: "Lessee settled" } as const
const CLAIM_TONE = { SUBMITTED: "warning", APPROVED: "info", PAID: "success", REJECTED: "neutral" } as const
const metric = (text: string) => <span className="block text-xl tabular-nums">{text}</span>

export function LeaseFundPanel(props: {
  loanId: string
  loanStatus: string
  today: string
  fund: FundView
  userId: string
  canManage: boolean
  canDecide: boolean
  options: ClaimOptions
}) {
  const { loanId, fund, userId, canDecide } = props
  const base = `/api/asset-finance/leases/${loanId}`
  const submit = canSubmitClaim({ loanStatus: props.loanStatus, today: props.today, leaseEndDate: fund.leaseEndDate, fundSettled: fund.settledAt !== null, canManage: props.canManage })
  return (
    <DataPanel
      title="Maintenance fund"
      description={`${RISK_LABELS[fund.riskModel]} · lease ends ${formatIsoDate(fund.leaseEndDate)}${fund.settledAt ? ` · settled ${formatIsoDate(fund.settledAt)}` : ""}`}
      density="loose"
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <MetricCard label="Fund balance" value={metric(formatMoney(fund.balanceCents))} tone={fund.balanceCents < 0 ? "warning" : "neutral"}
            detail={fund.balanceCents < 0 ? "Claims are ahead of contributions" : "Ex VAT"} />
          <MetricCard label="Contributed" value={metric(formatMoney(fund.contributedCents))} detail="Maintenance on invoiced rentals, ex VAT" />
          <MetricCard label="Claims paid" value={metric(formatMoney(fund.claimedCents))} detail="Ex VAT" />
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold text-[var(--cf-text-secondary)]">Claims</h3>
          <p className="mb-2 text-xs text-[var(--cf-text-muted)]">
            No one approves their own claim; a claim of {formatMoney(fund.dualApprovalCents)} or more needs two different approvers. Paying is recorded here; the money moves outside CredaFlow.
          </p>
          {fund.claims.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">No claims yet.</p>
          ) : (
            <ScrollTable maxHeight="max-h-96">
              <TableHeader>
                <TableRow>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Work</TableHead>
                  <TableHead className="text-right">Amount ex VAT</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fund.claims.map((c) => {
                  const actions = claimActions(c, { userId, canDecide })
                  return (
                    <TableRow key={c.id} className="align-top">
                      <TableCell>{formatIsoDate(c.submittedOn)}</TableCell>
                      <TableCell>{c.supplier}<span className="block text-xs text-[var(--cf-text-muted)]">{c.invoiceFile}</span></TableCell>
                      <TableCell className="max-w-64 whitespace-normal!">{c.description}</TableCell>
                      <TableCell className="text-right">{formatMoney(c.amountExclVatCents)}</TableCell>
                      <TableCell>
                        <StatusPill tone={CLAIM_TONE[c.status]}>{statusLabel(c.status)}</StatusPill>
                        <span className="mt-1 block text-xs text-[var(--cf-text-muted)]">
                          {c.status === "SUBMITTED" && c.firstApprovedById && "First approval given: a second approver is needed"}
                          {c.status === "REJECTED" && c.rejectionReason}
                          {c.status === "PAID" && c.paymentReference && `Ref ${c.paymentReference}`}
                        </span>
                      </TableCell>
                      <TableCell className="min-w-56 whitespace-normal!">
                        <ClaimActions url={`${base}/claims/${c.id}`} approve={actions.approve} reject={actions.reject} paid={actions.paid} hint={actions.hint} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </ScrollTable>
          )}
        </div>

        {submit && <ClaimSubmitForm url={`${base}/claims`} options={props.options} />}

        <div>
          <h3 className="mb-2 text-xs font-semibold text-[var(--cf-text-secondary)]">Movements</h3>
          {fund.movements.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">Nothing has moved yet: a rental adds its maintenance when it is invoiced.</p>
          ) : (
            <ScrollTable maxHeight="max-h-72">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Movement</TableHead>
                  <TableHead className="text-right">Amount ex VAT</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fund.movements.map((m) => {
                  const out = m.kind === "CLAIM" || m.kind === "SETTLEMENT_REFUND"
                  return (
                    <TableRow key={m.id}>
                      <TableCell>{formatIsoDate(m.occurredOn)}</TableCell>
                      <TableCell>{MOVEMENT_LABELS[m.kind]}{m.periodNo !== null && ` (rental ${m.periodNo})`}</TableCell>
                      <TableCell className="text-right">{out ? "−" : "+"} {formatMoney(m.amountCents)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </ScrollTable>
          )}
        </div>
      </div>
    </DataPanel>
  )
}
