import Link from "next/link"
import { redirect } from "next/navigation"
import { CreditCard, Download, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { PrintButton } from "./PrintButton"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatDate, formatZAR } from "@/lib/utils"
import { getDefaultTenantId } from "@/lib/tenant"
import { methodLabelWithReversal, reversalDetailLine } from "@/lib/payments/reversal-label"
import { displayPaymentMethod } from "@/lib/payments/waiver"

export default async function StatementPage() {
  const session = await auth()
  if (!session?.user) redirect("/portal/login")

  const tenantId = await getDefaultTenantId()

  const client = await prisma.client.findFirst({ where: { email: session.user.email!, tenantId } })
  if (!client) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
        <EmptyState
          icon={FileText}
          title="No client record found"
          description="This login is valid, but it is not linked to a client record yet. Contact support so we can connect your portal access."
          action={{ label: "Back to Overview", href: "/portal" }}
        />
      </div>
    )
  }

  const loans = await prisma.loan.findMany({
    where: { clientId: client.id, tenantId },
    include: {
      product: { select: { name: true } },
      payments: { orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }] },
    },
    orderBy: { startDate: "desc" },
  })

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6 md:py-8">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Your Account</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">Payment History & Statements</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
          View active loan balances, download official statements and track recorded repayments.
        </p>
      </div>

      {loans.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No loans on this account yet"
          description="Statements become available once a loan is approved and disbursed. You can apply online or upload supporting documents while an application is being reviewed."
          action={{ label: "Start Application", href: "/portal/apply" }}
          secondaryAction={
            <Button asChild variant="outline" size="sm">
              <Link href="/portal/documents">Manage Documents</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {loans.map((loan) => (
            <DataPanel
              key={loan.id}
              title={loan.reference}
              description={`${loan.product.name} / ${loan.status}`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm">
                    <a href={`/api/loans/${loan.id}/statement`} target="_blank" rel="noopener noreferrer">
                      <Download className="h-3.5 w-3.5" />
                      PDF
                    </a>
                  </Button>
                  <PrintButton />
                </div>
              }
            >
              <div className="mb-4 rounded-lg border border-[rgba(79,70,229,0.28)] bg-[rgba(79,70,229,0.06)] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">Payment Reference</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-[var(--cf-brand)]">{loan.reference}</p>
                <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">
                  Quote this reference on every payment or deposit so it is allocated to this loan.
                </p>
              </div>

              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">Outstanding</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--cf-text)]">{formatZAR(loan.outstandingPrincipal)}</p>
                </div>
                <div className="rounded-lg border border-[rgba(63,191,127,0.24)] bg-[rgba(63,191,127,0.08)] p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">Total Paid</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--cf-success)]">{formatZAR(loan.totalPaid)}</p>
                </div>
                <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">Total Repayable</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--cf-text)]">{formatZAR(loan.totalRepayable)}</p>
                </div>
              </div>

              {loan.payments.length === 0 ? (
                <EmptyState
                  icon={CreditCard}
                  title="No payments recorded yet"
                  description="Payment history will appear here once a repayment is captured or confirmed."
                  action={{ label: "Make Payment", href: "/portal/payment" }}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Reference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loan.payments.map((payment) => {
                      const method = displayPaymentMethod(payment.paymentMethod, (m) => m.toLowerCase().replace("_", " "))
                      const reversalDetail = reversalDetailLine(payment, formatDate)
                      const allocationDetail =
                        payment.allocationStatus === "UNAPPLIED"
                          ? "Allocation pending — this receipt has not reduced your loan balance."
                          : payment.allocationStatus === "REFUNDED"
                            ? "Refund recorded — this receipt is not counted as a repayment."
                            : null
                      const inactive =
                        payment.reversed || payment.allocationStatus !== "ALLOCATED"
                      return (
                        <TableRow
                          key={payment.id}
                          className={inactive ? "opacity-70" : undefined}
                          title={reversalDetail ?? allocationDetail ?? undefined}
                        >
                          <TableCell>{formatDate(payment.receivedAt)}</TableCell>
                          <TableCell className={`font-medium ${inactive ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"} ${payment.reversed ? "line-through" : ""}`}>{formatZAR(payment.amount)}</TableCell>
                          <TableCell className="capitalize">
                            {methodLabelWithReversal(method, payment.reversed)}
                            {!payment.reversed && payment.allocationStatus !== "ALLOCATED"
                              ? ` / ${payment.allocationStatus.toLowerCase()}`
                              : ""}
                            {reversalDetail && (
                              <span className="mt-0.5 block text-[11px] normal-case text-[var(--cf-text-muted)]">
                                {reversalDetail}
                              </span>
                            )}
                            {allocationDetail && (
                              <span className="mt-0.5 block text-[11px] normal-case text-[var(--cf-text-muted)]">
                                {allocationDetail}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{payment.reference || "-"}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </DataPanel>
          ))}
        </div>
      )}
    </div>
  )
}
