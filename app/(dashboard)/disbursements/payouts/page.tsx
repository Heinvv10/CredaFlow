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
import { conflictStateLabel, PAYOUT_STATUS_LABELS, type PayoutStatus } from "@/lib/payouts/state"
import { loadDoublePayoutRisks } from "@/lib/payouts/double-payout"
import { loadUnappliedReports } from "@/lib/payouts/unapplied-reports"
import { UnappliedReportAck } from "@/components/payouts/UnappliedReportAck"
import { formatZAR } from "@/lib/utils"

export const metadata = { title: "Outstanding payouts — Disbursements" }

const OPEN: PayoutStatus[] = ["PENDING", "SUBMITTING", "SUBMITTED", "PROCESSING", "NEEDS_REVIEW", "AWAITING_APPROVAL"]
const fmt = (d: Date | null) => (d ? d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }) : "—")

/**
 * Every payout that is not settled, every reversal awaiting a decision, and
 * what an approved reversal leaves (money paid out afterwards to recover, a
 * debit order to cancel by hand): the queue a second LOAN_ADMIN works.
 */
const REPORTS_PAGE_SIZE = 25

export default async function OutstandingPayoutsPage({ searchParams }: { searchParams: Promise<{ reports?: string }> }) {
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()
  const reportsPage = Math.max(Number.parseInt((await searchParams).reports ?? "1", 10) || 1, 1)
  const [payouts, reversals, recoveries, debitOrders, doubles, rejected] = await Promise.all([
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
    prisma.payoutRecoveryCase.findMany({
      where: { tenantId, status: { in: ["OPEN", "ESCALATED"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, loanId: true, status: true, amountCents: true, paidAt: true, loan: { select: { reference: true } } },
    }),
    prisma.disbursementReversal.findMany({
      where: { tenantId, status: "APPROVED", debitOrderCancelAckAt: null },
      orderBy: { decidedAt: "asc" },
      select: { id: true, loanId: true, decidedAt: true, loan: { select: { reference: true } } },
    }),
    loadDoublePayoutRisks(prisma, tenantId),
    // Provider reports not applied (stale, dropped, refused): someone must look.
    loadUnappliedReports(prisma, tenantId, { page: reportsPage, pageSize: REPORTS_PAGE_SIZE }),
  ])
  const reportPages = Math.max(Math.ceil(rejected.total / REPORTS_PAGE_SIZE), 1)
  const rejectedLoans = new Map((await prisma.disbursementPayout.findMany({
    where: { tenantId, id: { in: rejected.items.map((r) => r.payoutId) } },
    select: { id: true, attempt: true, loanId: true, loan: { select: { reference: true } } },
  })).map((p) => [p.id, p]))

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
                    {p.providerConflictState && !p.conflictResolvedAt && <p className="mt-1 text-[11px] text-[var(--cf-danger)]">Provider now reports {conflictStateLabel(p.providerConflictState)}</p>}
                    {doubles.filter((d) => d.payoutId === p.id).map((d) => (
                      <p key={d.liveAttempt} className="mt-1 text-[11px] font-semibold text-[var(--cf-danger)]">
                        Possible double payout: attempt #{d.liveAttempt} is {PAYOUT_STATUS_LABELS[d.liveStatus as PayoutStatus].toLowerCase()}
                      </p>
                    ))}
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
      {rejected.total > 0 && (
        <DataPanel
          title="Provider reports not applied"
          description={`${rejected.total} awaiting acknowledgement. Reports that changed nothing: stale (no money news, or a state the attempt cannot take), dropped (weaker than the open report, or already a recovery case) or refused by the database. Each stays here until someone checks the provider's report and the loan, and acknowledges it.`}
        >
          <ul className="space-y-3 text-sm">
            {rejected.items.map((r) => {
              const p = rejectedLoans.get(r.payoutId)
              return (
                <li key={r.id}>
                  {p ? <Link href={`/loans/${p.loanId}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">{p.loan.reference}</Link> : r.payoutId}
                  <span className={r.outcome === "rejected" || r.reported === "PAID" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}> · attempt #{p?.attempt ?? "?"} reported {r.reported || "?"} on {fmt(r.at)} · {r.outcome}{r.reason ? `: ${r.reason}` : ""}</span>
                  <UnappliedReportAck id={r.id} />
                </li>
              )
            })}
          </ul>
          {reportPages > 1 && (
            <p className="mt-3 flex gap-3 text-xs text-[var(--cf-text-muted)]">
              Page {reportsPage} of {reportPages}
              {reportsPage > 1 && <Link href={`?reports=${reportsPage - 1}`} className="underline">Newer</Link>}
              {reportsPage < reportPages && <Link href={`?reports=${reportsPage + 1}`} className="underline">Older</Link>}
            </p>
          )}
        </DataPanel>
      )}
      <DataPanel title="Reversed loans: staff tasks" description="Money paid out after a reversal, to recover; debit orders to cancel by hand. Act on the loan page.">
        {recoveries.length === 0 && debitOrders.length === 0 ? (
          <p className="text-sm text-[var(--cf-text-muted)]">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {recoveries.map((r) => (
              <li key={r.id}>
                <Link href={`/loans/${r.loanId}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">{r.loan.reference}</Link>
                <span className="text-[var(--cf-danger)]"> · funds paid out on a reversed loan: {formatZAR(r.amountCents)} on {fmt(r.paidAt)}{r.status === "ESCALATED" ? " · escalated" : ""}</span>
              </li>
            ))}
            {debitOrders.map((r) => (
              <li key={r.id}>
                <Link href={`/loans/${r.loanId}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">{r.loan.reference}</Link>
                <span className="text-[var(--cf-text-muted)]"> · reversed {fmt(r.decidedAt)} · cancel the debit order by hand, then acknowledge it</span>
              </li>
            ))}
          </ul>
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
