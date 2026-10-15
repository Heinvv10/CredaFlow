import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { displayPaymentMethod } from "@/lib/payments/waiver"
import { redirect } from "next/navigation"
import { formatZAR, formatDate } from "@/lib/utils"
import Link from "next/link"
import { Download, CreditCard } from "lucide-react"
import { BackLink } from "@/components/nav/BackLink"
import { getPortalTenantId } from "@/lib/session-tenant"
import { recurringInstalmentDue } from "@/lib/loan/instalment"
import { formatStatusLabel } from "@/lib/status-style"
import { documentLoanFigures, documentScheduleRow, owesNothing } from "@/lib/loan/charges-summary"
import { portalLoanCharges, portalOutstanding } from "@/lib/portal/loan-charges"
import { ChargesBreakdown } from "@/components/portal/ChargesBreakdown"
import { cashPaidPercent, cashReceivedCents } from "@/lib/payments/waiver"
import { SurrenderRequestCard } from "@/components/asset-finance/SurrenderRequestCard"

interface PageProps {
  params: Promise<{ id: string }>
}

async function getPortalLoan(loanId: string, email: string) {
  const tenantId = await getPortalTenantId()

  const client = await prisma.client.findFirst({ where: { email, tenantId } })
  if (!client) return null

  const loan = await prisma.loan.findFirst({
    where: { id: loanId, tenantId },
    include: {
      product: { select: { name: true } },
      repaymentSchedule: { orderBy: { installmentNo: "asc" } },
      payments: { orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }] },
      surrenderRequests: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true } },
    },
  })

  if (!loan || loan.clientId !== client.id) return null
  return loan
}

export default async function PortalLoanDetailPage({ params }: PageProps) {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const { id } = await params
  const loan = await getPortalLoan(id, session.user.email)
  if (!loan) redirect("/portal")

  const nextPayment = loan.repaymentSchedule.find(
    s => s.status === "PENDING" || s.status === "PARTIAL"
  )
  // Default charges are owed now, on top of the schedule (0 while off).
  const charges = await portalLoanCharges(loan.tenantId, loan.id, new Date())
  // What the client has paid is cash received; Loan.totalPaid is only the
  // share applied to the instalments once charges exist.
  const cashPaid = cashReceivedCents(loan.payments)
  const paidPct = cashPaidPercent(cashPaid, loan.totalRepayable)

  // Use the RECURRING instalment (schedule[1] for multi-instalment loans),
  // not the fee-loaded first instalment, so this matches the Apply quote.
  const monthlyInstalment = recurringInstalmentDue(loan.repaymentSchedule)
  // A loan CANCELLED by a disbursement reversal owes nothing (lib/loan/charges-summary.ts).
  const cancelled = owesNothing(loan)

  const statusColor: Record<string, { bg: string; text: string }> = {
    ACTIVE: { bg: "#D1FAE5", text: "#059669" },
    COMPLETED: { bg: "#DBEAFE", text: "#1D4ED8" },
    DEFAULTED: { bg: "#FEE2E2", text: "#DC2626" },
    PENDING_WRITE_OFF: { bg: "#FEF9C3", text: "#92400E" },
    WRITTEN_OFF: { bg: "#F3F4F6", text: "#6B7280" },
    CANCELLED: { bg: "#F3F4F6", text: "#1F2937" },
  }
  const sc = statusColor[loan.status] || statusColor.ACTIVE

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Back */}
      <BackLink href="/portal/loans" label="Back to Loans" className="mb-6" />

      {/* Hero card */}
      <div className="mb-6 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-6 text-[var(--cf-text)]">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-sm text-gray-400 font-mono">{loan.reference}</p>
            <p className="text-xs mt-0.5" style={{ color: "#4338CA" }}>{loan.product.name}</p>
          </div>
          <div className="flex items-center gap-3">
            {loan.daysInArrears > 0 && (
              <span className="rounded bg-red-500/20 px-2 py-1 text-xs font-bold text-[var(--cf-danger)]">
                {loan.daysInArrears} days overdue
              </span>
            )}
            <span
              className="px-3 py-1 rounded text-xs font-bold"
              style={{ backgroundColor: sc.bg, color: sc.text }}
            >
              {formatStatusLabel(loan.status)}
            </span>
          </div>
        </div>
        <p className="text-3xl font-bold mt-4">{formatZAR(portalOutstanding(loan.outstandingPrincipal, charges))}</p>
        <p className="text-xs text-gray-400 mt-1">Outstanding Balance</p>
        <ChargesBreakdown lines={charges.lines} className="mt-1" />
      </div>

      {/* Summary grid 2x3 */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        {[
          { label: "Principal", value: formatZAR(loan.principal) },
          { label: "Total Repayable", value: formatZAR(documentLoanFigures(loan).totalRepayable) },
          { label: "Total Paid", value: formatZAR(cashPaid) },
          { label: "Monthly Instalment", value: cancelled ? "—" : formatZAR(monthlyInstalment) },
          { label: "Next Payment Date", value: nextPayment ? formatDate(nextPayment.dueDate) : "—" },
          {
            label: "Next Payment Amount",
            value: nextPayment ? formatZAR(nextPayment.totalDue - nextPayment.totalPaid + charges.outstanding) : "—",
            // Why it differs from the monthly instalment.
            sub: nextPayment ? charges.lines : [],
          },
        ].map(item => (
          <div key={item.label} className="bg-white rounded-lg border border-gray-100 shadow-sm p-4 text-center">
            <p className="text-[10px] text-gray-400 uppercase tracking-widest mb-1">{item.label}</p>
            <p className="text-lg font-bold text-gray-900">{item.value}</p>
            {"sub" in item && item.sub && <ChargesBreakdown lines={item.sub} className="mt-1" />}
          </div>
        ))}
      </div>

      {/* Progress */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-5 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-600">You have paid {paidPct}% of your loan</span>
          <span className="text-sm font-bold" style={{ color: "#4338CA" }}>{paidPct}%</span>
        </div>
        <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.min(paidPct, 100)}%`, backgroundColor: "#4338CA" }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-gray-400">
          <span>Paid: <span className="whitespace-nowrap">{formatZAR(cashPaid)}</span></span>
          <span>Total: <span className="whitespace-nowrap">{formatZAR(documentLoanFigures(loan).totalRepayable)}</span></span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 mb-6">
        <a href={`/api/loans/${loan.id}/statement`} target="_blank" rel="noopener noreferrer">
          <button
            className="flex items-center gap-2 px-5 py-2.5 rounded-md text-white font-semibold text-sm"
            style={{ backgroundColor: "#4338CA" }}
          >
            <Download className="h-4 w-4" />
            Download Statement
          </button>
        </a>
        {/* Nothing is owed on a reversed loan: no way to pay it. */}
        {!cancelled && (
          <Link href="/portal/payment">
            <button
              className="flex items-center gap-2 px-5 py-2.5 rounded-md border font-semibold text-sm"
              style={{ borderColor: "#4338CA", color: "#4338CA" }}
            >
              <CreditCard className="h-4 w-4" />
              Make a Payment
            </button>
          </Link>
        )}
      </div>

      {/* Tabs — Repayment Schedule + Payment History */}
      <PortalLoanTabs loan={loan} />
      {loan.ncaRegime === "NCA" && loan.contractType !== "LOAN" && loan.assetId && (
        <div className="mt-6">
          <SurrenderRequestCard loanId={loan.id} existing={loan.surrenderRequests[0] ?? null} />
        </div>
      )}
    </div>
  )
}

function PortalLoanTabs({ loan }: { loan: Awaited<ReturnType<typeof getPortalLoan>> }) {
  if (!loan) return null

  return (
    <div className="space-y-6">
      {/* Repayment Schedule */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50">
          <h2 className="font-bold text-gray-900">Repayment Schedule</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "#F8F8F8" }}>
                {["No.", "Due Date", "Amount", "Status"].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loan.repaymentSchedule.map((s, i) => {
                const isPaid = s.status === "PAID"
                const isOverdue = s.status === "OVERDUE"
                const isNext = !isPaid && !isOverdue && i === loan.repaymentSchedule.findIndex(
                  x => x.status === "PENDING" || x.status === "PARTIAL"
                )
                return (
                  <tr
                    key={s.id}
                    className="border-b border-gray-50"
                    style={{
                      backgroundColor: isNext ? "#F5F7FF" : isOverdue ? "#FEF2F2" : isPaid ? "#F0FDF4" : i % 2 === 0 ? "#fff" : "#fafafa",
                    }}
                  >
                    <td className="px-5 py-3 text-gray-600">{s.installmentNo}</td>
                    <td className="px-5 py-3 text-gray-700">{formatDate(s.dueDate)}</td>
                    <td className="px-5 py-3 font-medium text-gray-900">{formatZAR(documentScheduleRow(s).totalDue)}</td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                        isPaid ? "bg-green-100 text-green-700" :
                        isOverdue ? "bg-red-100 text-red-700" :
                        s.status === "PARTIAL" ? "bg-amber-100 text-amber-700" :
                        "bg-gray-100 text-gray-600"
                      }`}>
                        {s.status}
                      </span>
                      {isNext && (
                        <span className="ml-2 text-[10px] font-semibold" style={{ color: "#4338CA" }}>← NEXT</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payment History */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
          <h2 className="font-bold text-gray-900">Payment History</h2>
          <a href={`/api/loans/${loan.id}/statement`} target="_blank" rel="noopener noreferrer">
            <button
              className="px-3 py-1.5 rounded border text-xs font-semibold"
              style={{ borderColor: "#4338CA", color: "#4338CA" }}
            >
              Download Statement
            </button>
          </a>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "#F8F8F8" }}>
                {["Date", "Amount", "Method", "Reference"].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loan.payments.length === 0 ? (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-gray-400 text-sm">No payments recorded yet</td></tr>
              ) : (
                loan.payments.map((p, i) => {
                  const inactive =
                    p.reversed || p.allocationStatus !== "ALLOCATED"
                  const status = p.reversed
                    ? "reversed"
                    : p.allocationStatus === "UNAPPLIED"
                      ? "allocation pending"
                      : p.allocationStatus === "REFUNDED"
                        ? "refunded"
                        : null
                  return (
                  <tr key={p.id} className={`border-b border-gray-50 ${inactive ? "opacity-70" : ""}`} style={{ backgroundColor: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <td className="px-5 py-3 text-gray-700">{formatDate(p.receivedAt)}</td>
                    <td className="px-5 py-3 font-medium text-gray-900">{formatZAR(p.amount)}</td>
                    <td className="px-5 py-3 text-gray-600 capitalize">
                      {displayPaymentMethod(p.paymentMethod, (method) => method.toLowerCase().replace("_", " "))}
                      {status ? ` / ${status}` : ""}
                    </td>
                    <td className="px-5 py-3 font-mono text-gray-500 text-xs">{p.reference || "—"}</td>
                  </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
