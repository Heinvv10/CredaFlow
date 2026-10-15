import Link from "next/link"
import { Banknote } from "lucide-react"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { PAYOUT_STATUS_LABELS, type PayoutStatus } from "@/lib/payouts/state"
import { formatZAR } from "@/lib/utils"

export const metadata = { title: "Outstanding payouts — Disbursements" }

const OPEN: PayoutStatus[] = ["PENDING", "SUBMITTING", "SUBMITTED", "PROCESSING", "NEEDS_REVIEW", "AWAITING_APPROVAL"]
const fmt = (d: Date | null) => (d ? d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }) : "—")

/** Every payout that is not settled, and every reversal awaiting a decision: the queue a second LOAN_ADMIN works. */
export default async function OutstandingPayoutsPage() {
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()
  const [payouts, reversals] = await Promise.all([
    prisma.disbursementPayout.findMany({
      // Unsettled, or settled but contradicted by a later provider report.
      where: { tenantId, OR: [{ status: { in: OPEN } }, { providerConflictAt: { not: null }, conflictResolvedAt: null }] },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, loanId: true, attempt: true, status: true, providerConflictState: true, conflictResolvedAt: true, amountCents: true, provider: true, bankName: true, accountNumber: true, submittedAt: true, createdAt: true, loan: { select: { reference: true } } },
    }),
    prisma.disbursementReversal.findMany({
      where: { tenantId, status: "REQUESTED" },
      orderBy: { requestedAt: "asc" },
      select: { id: true, loanId: true, reason: true, requestedAt: true, loan: { select: { reference: true } } },
    }),
  ])

  return (
    <div className="space-y-6 px-4 py-5 lg:px-8 lg:py-7">
      <div className="border-b border-[var(--cf-border-subtle)] pb-5">
        <Breadcrumbs className="mb-3" items={[{ label: "Disbursements", href: "/disbursements" }, { label: "Outstanding payouts" }]} />
        <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">Outstanding payouts</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
          Payouts not yet settled, oldest first: waiting to send, at the provider, needing review, a retry awaiting approval, or a failed payout a provider now reports paid. Open the loan to act.
        </p>
      </div>
      <DataPanel title="Payouts" description={`${payouts.length} not settled`}>
        {payouts.length === 0 ? (
          <EmptyState icon={Banknote} title="Nothing outstanding" description="Every payout is paid, failed or returned." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Loan</TableHead>
                <TableHead>Attempt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payouts.map((p) => (
                <TableRow key={p.id}>
                  <TableCell><Link href={`/loans/${p.loanId}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">{p.loan.reference}</Link></TableCell>
                  <TableCell>#{p.attempt} · {p.provider}</TableCell>
                  <TableCell>
                    <StatusPill tone={p.status === "NEEDS_REVIEW" || p.providerConflictState ? "danger" : "warning"}>{PAYOUT_STATUS_LABELS[p.status as PayoutStatus]}</StatusPill>
                    {p.providerConflictState && !p.conflictResolvedAt && <p className="mt-1 text-[11px] text-[var(--cf-danger)]">Provider now reports {p.providerConflictState}</p>}
                  </TableCell>
                  <TableCell>{p.bankName} ••••{p.accountNumber.slice(-4)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatZAR(p.amountCents)}</TableCell>
                  <TableCell>{fmt(p.submittedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataPanel>
      <DataPanel title="Reversals awaiting a decision" description="Disbursements whose money never arrived; a second LOAN_ADMIN approves or rejects on the loan page.">
        {reversals.length === 0 ? (
          <p className="text-sm text-[var(--cf-text-muted)]">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {reversals.map((r) => (
              <li key={r.id}>
                <Link href={`/loans/${r.loanId}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">{r.loan.reference}</Link>
                <span className="text-[var(--cf-text-muted)]"> · requested {fmt(r.requestedAt)} · {r.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </DataPanel>
    </div>
  )
}
