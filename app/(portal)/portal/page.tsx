import { waHref } from "@/lib/support/whatsapp-intents"
import Link from "next/link"
import { redirect } from "next/navigation"
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  CheckCircle,
  CreditCard,
  Download,
  FileText,
  HelpCircle,
  Search,
  Upload,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { portalLoanCharges, portalOutstanding, sumPortalCharges, type PortalCharges } from "@/lib/portal/loan-charges"
import { ChargesBreakdown } from "@/components/portal/ChargesBreakdown"
import { CASH_RECEIPTS, cashPaidPercent, displayPaymentMethod } from "@/lib/payments/waiver"
import { formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { getStatusTone } from "@/lib/status-style"
import { getDefaultTenantId } from "@/lib/tenant"
import { getLenderIdentity } from "@/lib/config/identity"
import {
  OPEN_PORTAL_LOAN_STATUSES,
  portalLoanStatusLabel,
  portalOverviewLoanQuery,
  projectPortalLoanOverview,
} from "@/lib/portal/loan-overview"
import { sastHour } from "@/lib/date/sast"

async function getPortalData(email: string) {
  const tenantId = await getDefaultTenantId()

  const client = await prisma.client.findFirst({ where: { email, tenantId } })
  if (!client) return null

  const pendingAgreement = await prisma.loanApplication.findFirst({
    where: {
      clientId: client.id,
      tenantId,
      agreementGeneratedAt: { not: null },
      agreementSignedAt: null,
      status: "APPROVED",
    },
    select: { id: true, reference: true },
  })
  const pendingMandate = await prisma.loanApplication.findFirst({
    where: {
      clientId: client.id,
      tenantId,
      agreementSignedAt: { not: null },
      debitMandateSignedAt: null,
      repaymentMethod: "DEBIT_ORDER",
      status: "APPROVED",
    },
    select: { id: true, reference: true },
  })

  const loans = await prisma.loan.findMany(portalOverviewLoanQuery(client.id, tenantId))

  const recentPayments = await prisma.payment.findMany({
    where: { tenantId, loan: { clientId: client.id } },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
    take: 5,
  })

  const nextSchedule = await prisma.repaymentSchedule.findFirst({
    where: {
      tenantId,
      loan: {
        clientId: client.id,
        status: { in: [...OPEN_PORTAL_LOAN_STATUSES] },
      },
      status: { in: ["PENDING", "PARTIAL"] },
    },
    orderBy: { dueDate: "asc" },
  })

  const documents = await prisma.clientDocument.findMany({
    where: { tenantId, clientId: client.id, deletedAt: null },
    select: { docType: true, verified: true },
  })

  const insurancePolicies = await prisma.insurancePolicy.findMany({
    where: { clientId: client.id },
    select: { id: true, policyNumber: true, status: true, premiumAmount: true, sumAssured: true },
    orderBy: { createdAt: "desc" },
  })

  // Default charges owed across the client's open loans — the loans the
  // outstanding balance covers (none while off).
  const asOf = new Date()
  const openLoans = loans.filter((loan) => (OPEN_PORTAL_LOAN_STATUSES as readonly string[]).includes(loan.status))
  const charges = sumPortalCharges(await Promise.all(
    openLoans.map((loan) => portalLoanCharges(tenantId, loan.id, asOf)),
  ))
  // Cash received per loan: "paid" is money in, waivers excluded.
  const cashPaid = new Map((await prisma.payment.groupBy({
    by: ["loanId"],
    where: { tenantId, loanId: { in: loans.map((loan) => loan.id) }, reversed: false, allocationStatus: "ALLOCATED", ...CASH_RECEIPTS },
    _sum: { amount: true },
  })).map((row) => [row.loanId, row._sum.amount ?? 0]))

  return {
    client,
    loans,
    charges,
    cashPaid,
    recentPayments,
    nextSchedule,
    documents,
    pendingAgreement,
    pendingMandate,
    insurancePolicies,
  }
}

function relativeTime(date: Date | string): string {
  const now = new Date()
  const d = typeof date === "string" ? new Date(date) : date
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: SAST_TIME_ZONE })
}

function daysUntil(date: Date | string): number {
  const now = new Date()
  const d = typeof date === "string" ? new Date(date) : date
  return Math.ceil((d.getTime() - now.getTime()) / 86400000)
}

export default async function ClientPortalPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const data = await getPortalData(session.user.email)
  // Same tenant source as the page's own data above, so the contact
  // details and account name always belong to the lender whose loans are shown.
  const identity = await getLenderIdentity(await getDefaultTenantId())
  // SAST hour — see the staff dashboard.
  const hour = sastHour(new Date())
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
  const firstName = session.user.name?.split(" ")[0] || "there"

  const loanOverview = projectPortalLoanOverview(data?.loans ?? [])
  const { totalOutstanding, maxArrears, primaryLoan } = loanOverview
  const hasArrears = maxArrears > 0
  const totalPaid = primaryLoan ? data?.cashPaid.get(primaryLoan.id) ?? 0 : 0
  const totalRepayable = primaryLoan ? Number(primaryLoan.totalRepayable || primaryLoan.principal) : 0
  const progressPct = cashPaidPercent(totalPaid, totalRepayable)

  if (!data?.client) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
        <DataPanel>
          <div className="p-8 text-center">
            <p className="mb-3 text-sm text-[var(--cf-text-secondary)]">No client account found for this email address.</p>
            <p className="text-xs text-[var(--cf-text-muted)]">Contact {identity.publicEmail} to get started.</p>
          </div>
        </DataPanel>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-6 md:py-8">
      {data.pendingAgreement && (
        <DataPanel className="border-[rgba(217,154,58,0.35)] bg-[rgba(217,154,58,0.08)]">
          <div className="flex flex-col gap-4 p-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
              <div>
                <p className="text-sm font-semibold text-[var(--cf-text)]">Credit agreement awaiting your signature</p>
                <p className="text-xs text-[var(--cf-text-muted)]">Application {data.pendingAgreement.reference}</p>
              </div>
            </div>
            <Button asChild size="sm">
              <Link href={`/portal/agreement/${data.pendingAgreement.id}`}>Review and Sign</Link>
            </Button>
          </div>
        </DataPanel>
      )}

      {!data.pendingAgreement && data.pendingMandate && (
        <DataPanel className="border-[rgba(217,154,58,0.35)] bg-[rgba(217,154,58,0.08)]">
          <div className="flex flex-col gap-4 p-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
              <div>
                <p className="text-sm font-semibold text-[var(--cf-text)]">
                  Repayment setup awaiting your signature
                </p>
                <p className="text-xs text-[var(--cf-text-muted)]">
                  Application {data.pendingMandate.reference}
                </p>
              </div>
            </div>
            <Button asChild size="sm">
              <Link href={`/portal/mandate/${data.pendingMandate.id}`}>
                Set Up Repayment
              </Link>
            </Button>
          </div>
        </DataPanel>
      )}

      {hasArrears ? (
        <ArrearsHero firstName={firstName} daysOverdue={maxArrears} outstanding={portalOutstanding(totalOutstanding, data.charges)} charges={data.charges} whatsappE164={identity.publicWhatsappE164} />
      ) : (
        <PaymentHero firstName={firstName} greeting={greeting} nextSchedule={data.nextSchedule} charges={data.charges} />
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Outstanding Balance" value={formatZAR(portalOutstanding(totalOutstanding, data.charges))} />
        <ProgressRingCard label="Paid to Date" value={formatZAR(totalPaid)} percent={progressPct} />
        <StatCard label="Loan Reference" value={primaryLoan?.reference || "---"} sub={primaryLoan?.product.name} />
        <StatCard
          label="Account Status"
          value={primaryLoan ? portalLoanStatusLabel(primaryLoan.status, hasArrears) : "No Loan"}
          tone={hasArrears ? "danger" : primaryLoan?.status === "COMPLETED" || primaryLoan?.status === "ACTIVE" ? "success" : "neutral"}
        />
      </div>

      <DataPanel title="Quick Actions" description="Secure shortcuts for the next client task.">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { icon: CreditCard, label: "Make Payment", href: "/portal/payment" },
            { icon: Calendar, label: "View Schedule", href: primaryLoan ? `/portal/loans/${primaryLoan.id}` : "/portal/loans" },
            {
              icon: Download,
              label: "Download Statement",
              href: data.loans.length === 1 ? `/api/loans/${data.loans[0].id}/statement` : "/portal/statement",
            },
            { icon: Upload, label: "Upload Document", href: "/portal/documents" },
            { icon: Search, label: "Track Application", href: "/portal/applications" },
            ...(identity.publicWhatsappE164
              ? [{ icon: HelpCircle, label: "Get Help", href: waHref(identity.publicWhatsappE164, "Hi, I need help with my loan account") }]
              : []),
          ].map((action) => {
            const isDownload = action.href.startsWith("/api/")
            const isExternal = action.href.startsWith("http")
            const content = (
              <>
                <action.icon className="h-4 w-4 text-[var(--cf-brand-soft)]" />
                {action.label}
              </>
            )

            return (
              <Button key={action.label} asChild variant="outline" className="justify-start">
                {isDownload || isExternal ? (
                  <a href={action.href} {...(isExternal || isDownload ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                    {content}
                  </a>
                ) : (
                  <Link href={action.href}>{content}</Link>
                )}
              </Button>
            )
          })}
        </div>
      </DataPanel>

      <DataPanel
        title="Recent Activity"
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/portal/statement">View all</Link>
          </Button>
        }
      >
        {data.recentPayments.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--cf-text-muted)]">No recent activity</div>
        ) : (
          <div className="divide-y divide-[var(--cf-border-subtle)]">
            {data.recentPayments.map((p) => {
              const isAllocated =
                p.allocationStatus === "ALLOCATED" && !p.reversed
              const title = p.reversed
                ? "Payment reversed"
                : p.allocationStatus === "UNAPPLIED"
                  ? "Payment received — allocation pending"
                  : p.allocationStatus === "REFUNDED"
                    ? "Refund recorded"
                    : "Payment allocated"
              return (
                <div key={p.id} className="flex items-center gap-3 py-3.5">
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    isAllocated
                      ? "bg-[rgba(63,191,127,0.12)] text-[var(--cf-success)]"
                      : "bg-amber-50 text-amber-700"
                  }`}>
                    {isAllocated
                      ? <CheckCircle className="h-4 w-4" />
                      : <AlertCircle className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--cf-text)]">{title}</p>
                    <p className="text-xs text-[var(--cf-text-muted)]">
                      {p.paymentMethod
                        ? displayPaymentMethod(p.paymentMethod, (method) => method.toLowerCase().replace("_", " "))
                        : "Payment"}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-[var(--cf-text)]">{formatZAR(p.amount)}</p>
                    <p className="text-[11px] text-[var(--cf-text-muted)]">{relativeTime(p.receivedAt)}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </DataPanel>

      <DocumentsSummary documents={data.documents} />
      <InsuranceSection policies={data.insurancePolicies} />
    </div>
  )
}

function PaymentHero({
  firstName,
  greeting,
  nextSchedule,
  charges,
}: {
  firstName: string
  greeting: string
  nextSchedule: { dueDate: Date; totalDue: number } | null | undefined
  charges: PortalCharges
}) {
  const dueDays = nextSchedule ? daysUntil(nextSchedule.dueDate) : null

  return (
    <section className="rounded-lg border border-[var(--cf-border-strong)] bg-[linear-gradient(135deg,var(--cf-bg-raised),var(--cf-bg-panel))] p-6 md:p-8">
      <p className="text-sm text-[var(--cf-text-muted)]">{greeting}, {firstName}</p>
      <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Your Next Payment</p>
      {nextSchedule ? (
        <>
          <p className="mt-1 text-4xl font-semibold text-[var(--cf-brand-soft)] md:text-5xl">{formatZAR(nextSchedule.totalDue + charges.outstanding)}</p>
          <ChargesBreakdown lines={charges.lines} className="mt-1" />
          <p className="mt-2 text-sm text-[var(--cf-text-muted)]">
            {dueDays !== null && dueDays > 0
              ? `Due in ${dueDays} day${dueDays === 1 ? "" : "s"}`
              : dueDays === 0
                ? "Due today"
                : `Overdue by ${Math.abs(dueDays || 0)} days`}
            {" / "}
            {new Date(nextSchedule.dueDate).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: SAST_TIME_ZONE })}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button asChild><Link href="/portal/payment">Pay Now</Link></Button>
            <Button asChild variant="outline"><Link href="/portal/loans">View Schedule</Link></Button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-2xl font-semibold text-[var(--cf-text-muted)]">No upcoming payments</p>
      )}
    </section>
  )
}

function ArrearsHero({ firstName, daysOverdue, outstanding, charges, whatsappE164 }: {
  firstName: string
  daysOverdue: number
  outstanding: number
  charges: PortalCharges
  whatsappE164: string | null
}) {
  return (
    <section className="rounded-lg border border-[rgba(208,92,75,0.42)] bg-[rgba(208,92,75,0.08)] p-6 md:p-8">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-[var(--cf-danger)]" />
        <p className="text-sm font-semibold text-[var(--cf-danger)]">Account in Arrears</p>
      </div>
      <p className="text-sm text-[var(--cf-text-secondary)]">
        {firstName}, your account is {daysOverdue} day{daysOverdue === 1 ? "" : "s"} overdue
      </p>
      <p className="mt-2 text-3xl font-semibold text-[var(--cf-text)] md:text-4xl">{formatZAR(outstanding)}</p>
      <p className="mt-1 text-sm text-[var(--cf-text-muted)]">Outstanding balance</p>
      <ChargesBreakdown lines={charges.lines} className="mt-1" />
      <div className="mt-5 flex flex-wrap gap-3">
        {whatsappE164 && (
          <Button asChild><a href={waHref(whatsappE164, "Hi, I need help with my overdue account")} target="_blank" rel="noopener noreferrer">Contact Us</a></Button>
        )}
        <Button asChild variant="outline"><Link href="/portal/payment">Make Payment</Link></Button>
      </div>
    </section>
  )
}

function StatCard({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: "success" | "danger" | "neutral" }) {
  return (
    <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-4">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">{label}</p>
      <p className="truncate text-lg font-semibold text-[var(--cf-text)]">{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-[var(--cf-text-muted)]">{sub}</p>}
      {tone !== "neutral" && <Badge variant={tone} className="mt-2">{tone === "success" ? "Clear" : "Action needed"}</Badge>}
    </div>
  )
}

function ProgressRingCard({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-4">
      <div className="relative h-12 w-12 shrink-0">
        <div className="h-12 w-12 rounded-full" style={{ background: `conic-gradient(var(--cf-brand) ${percent * 3.6}deg, var(--cf-surface-strong) ${percent * 3.6}deg)` }} />
        <div className="absolute inset-1 flex items-center justify-center rounded-full bg-[var(--cf-bg-panel)]">
          <span className="text-[10px] font-semibold text-[var(--cf-text-secondary)]">{percent}%</span>
        </div>
      </div>
      <div className="min-w-0">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">{label}</p>
        <p className="truncate text-sm font-semibold text-[var(--cf-text)]">{value}</p>
      </div>
    </div>
  )
}

function DocumentsSummary({ documents }: { documents: Array<{ docType: string; verified: boolean }> }) {
  const required = ["ID_COPY", "PAYSLIP", "BANK_STATEMENT", "PROOF_OF_ADDRESS"]
  const uploaded = documents.length
  const verified = documents.filter((d) => d.verified).length
  const missing = required.filter((r) => !documents.some((d) => d.docType === r))
  const labels: Record<string, string> = {
    ID_COPY: "ID Copy",
    PAYSLIP: "Payslip",
    BANK_STATEMENT: "Bank Statement",
    PROOF_OF_ADDRESS: "Proof of Address",
  }

  return (
    <DataPanel
      title="My Documents"
      actions={<Button asChild variant="ghost" size="sm"><Link href="/portal/documents">Manage documents</Link></Button>}
    >
      <div className="mb-3 flex items-center gap-6 text-sm text-[var(--cf-text-muted)]">
        <span>Uploaded: <strong className="text-[var(--cf-text)]">{uploaded}</strong></span>
        <span>Verified: <strong className="text-[var(--cf-success)]">{verified}</strong></span>
      </div>
      {missing.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-[rgba(217,154,58,0.24)] bg-[rgba(217,154,58,0.08)] p-3 text-sm text-[var(--cf-warning)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Missing required documents: {missing.map((m) => labels[m] || m).join(", ")}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-[rgba(63,191,127,0.24)] bg-[rgba(63,191,127,0.08)] p-3 text-sm text-[var(--cf-success)]">
          <CheckCircle className="h-4 w-4 shrink-0" />
          All required documents uploaded
        </div>
      )}
    </DataPanel>
  )
}

function InsuranceSection({
  policies,
}: {
  policies: Array<{
    id: string
    policyNumber: string
    status: string
    premiumAmount: number | bigint | { toNumber(): number }
    sumAssured: number | bigint | { toNumber(): number }
  }>
}) {
  return (
    <DataPanel title="My Insurance">
      {policies.length === 0 ? (
        <div className="py-6 text-center text-sm text-[var(--cf-text-muted)]">No active insurance policies.</div>
      ) : (
        <div className="space-y-3">
          {policies.map((policy) => (
            <div key={policy.id} className="flex items-center justify-between rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
              <div>
                <p className="text-sm font-semibold text-[var(--cf-text)]">{policy.policyNumber}</p>
                {/* premiumAmount / sumAssured are stored in RANDS (API divides
                    the cents the form sends by 100 — see app/api/insurance/policies).
                    formatZAR expects CENTS, so multiply by 100, matching the staff
                    surfaces (e.g. settings/products/insurance). Without this the
                    portal showed premiums 100× too small (R5 → "R 0.05"). F-01. */}
                <p className="mt-0.5 text-[12px] text-[var(--cf-text-muted)]">Coverage: <span className="whitespace-nowrap">{formatZAR(Number(policy.sumAssured) * 100)}</span></p>
              </div>
              <div className="text-right">
                <Badge variant={getStatusTone(policy.status)}>{policy.status}</Badge>
                <p className="mt-1 text-[12px] text-[var(--cf-text-muted)]"><span className="whitespace-nowrap">{formatZAR(Number(policy.premiumAmount) * 100)}</span>/mo</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </DataPanel>
  )
}
