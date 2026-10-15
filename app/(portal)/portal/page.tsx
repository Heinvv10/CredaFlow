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
import { CASH_RECEIPTS, cashPaidPercent } from "@/lib/payments/waiver"
import { formatZAR } from "@/lib/utils"
import { getStatusTone } from "@/lib/status-style"
import { getPortalTenantId } from "@/lib/session-tenant"
import { getLenderIdentity } from "@/lib/config/identity"
import {
  OPEN_PORTAL_LOAN_STATUSES,
  portalOverviewLoanQuery,
  projectPortalLoanOverview,
} from "@/lib/portal/loan-overview"
import { sastHour } from "@/lib/date/sast"
import { owesNothing } from "@/lib/loan/charges-summary"
import { getLocale } from "@/lib/i18n/server"
import { createTranslator, type Translator } from "@/lib/i18n/translate"
import { formatDayMonth, formatLongDay } from "@/lib/i18n/format"
import { docTypeLabel, loanStatusTitle, paymentMethodLabel, statusLabel } from "@/lib/i18n/portal-labels"
import type { Locale } from "@/lib/i18n/locales"

type HomeT = Translator<"portalHome">
type LabelsT = Translator<"portalLabels">


async function getPortalData(email: string) {
  const tenantId = await getPortalTenantId()

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
    where: { tenantId, clientId: client.id },
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

function relativeTime(date: Date | string, t: HomeT, locale: Locale): string {
  const now = new Date()
  const d = typeof date === "string" ? new Date(date) : date
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return t("justNow")
  if (diffMins < 60) return t("minutesAgo", { n: diffMins })
  if (diffHours < 24) return t("hoursAgo", { n: diffHours })
  if (diffDays < 7) return t("daysAgo", { n: diffDays })
  return formatDayMonth(d, locale)
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
  const identity = await getLenderIdentity(await getPortalTenantId())
  const locale = await getLocale()
  const t = createTranslator(locale, "portalHome")
  const l = createTranslator(locale, "portalLabels")
  // SAST hour — see the staff dashboard.
  const hour = sastHour(new Date())
  const greeting = t(hour < 12 ? "goodMorning" : hour < 17 ? "goodAfternoon" : "goodEvening")
  const firstName = session.user.name?.split(" ")[0] || t("fallbackName")

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
            <p className="mb-3 text-sm text-[var(--cf-text-secondary)]">{t("noClientAccount")}</p>
            <p className="text-xs text-[var(--cf-text-muted)]">{t("contactToStart", { email: identity.publicEmail })}</p>
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
                <p className="text-sm font-semibold text-[var(--cf-text)]">{t("agreementAwaiting")}</p>
                <p className="text-xs text-[var(--cf-text-muted)]">{t("applicationRef", { reference: data.pendingAgreement.reference })}</p>
              </div>
            </div>
            <Button asChild size="sm">
              <Link href={`/portal/agreement/${data.pendingAgreement.id}`}>{t("reviewAndSign")}</Link>
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
                  {t("mandateAwaiting")}
                </p>
                <p className="text-xs text-[var(--cf-text-muted)]">
                  {t("applicationRef", { reference: data.pendingMandate.reference })}
                </p>
              </div>
            </div>
            <Button asChild size="sm">
              <Link href={`/portal/mandate/${data.pendingMandate.id}`}>
                {t("setUpRepayment")}
              </Link>
            </Button>
          </div>
        </DataPanel>
      )}

      {hasArrears ? (
        <ArrearsHero firstName={firstName} daysOverdue={maxArrears} outstanding={portalOutstanding(totalOutstanding, data.charges)} charges={data.charges} whatsappE164={identity.publicWhatsappE164} t={t} l={l} />
      ) : (
        <PaymentHero firstName={firstName} greeting={greeting} nextSchedule={data.nextSchedule} charges={data.charges} t={t} l={l} locale={locale} />
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard t={t} label={t("statOutstanding")} value={formatZAR(portalOutstanding(totalOutstanding, data.charges))} />
        <ProgressRingCard label={t("statPaid")} value={formatZAR(totalPaid)} percent={progressPct} />
        <StatCard t={t} label={t("statLoanRef")} value={primaryLoan?.reference || "---"} sub={primaryLoan?.product.name} />
        <StatCard
          t={t}
          label={t("statAccountStatus")}
          value={primaryLoan ? loanStatusTitle(l, primaryLoan.status, hasArrears) : t("noLoan")}
          tone={hasArrears ? "danger" : primaryLoan?.status === "COMPLETED" || primaryLoan?.status === "ACTIVE" ? "success" : "neutral"}
        />
      </div>

      <DataPanel title={t("quickActions")} description={t("quickActionsDesc")}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[
            // No shortcut to pay when every loan was reversed (nothing is owed).
            ...(data.loans.length > 0 && data.loans.every(owesNothing) ? [] : [{ icon: CreditCard, label: t("makePayment"), href: "/portal/payment" }]),
            { icon: Calendar, label: t("viewSchedule"), href: primaryLoan ? `/portal/loans/${primaryLoan.id}` : "/portal/loans" },
            {
              icon: Download,
              label: t("downloadStatement"),
              href: data.loans.length === 1 ? `/api/loans/${data.loans[0].id}/statement` : "/portal/statement",
            },
            { icon: Upload, label: t("uploadDocument"), href: "/portal/documents" },
            { icon: Search, label: t("trackApplication"), href: "/portal/applications" },
            ...(identity.publicWhatsappE164
              ? [{ icon: HelpCircle, label: t("getHelp"), href: waHref(identity.publicWhatsappE164, "Hi, I need help with my loan account") }]
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
        title={t("recentActivity")}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/portal/statement">{t("viewAll")}</Link>
          </Button>
        }
      >
        {data.recentPayments.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--cf-text-muted)]">{t("noRecentActivity")}</div>
        ) : (
          <div className="divide-y divide-[var(--cf-border-subtle)]">
            {data.recentPayments.map((p) => {
              const isAllocated =
                p.allocationStatus === "ALLOCATED" && !p.reversed
              const title = t(p.reversed
                ? "paymentReversed"
                : p.allocationStatus === "UNAPPLIED"
                  ? "paymentPending"
                  : p.allocationStatus === "REFUNDED"
                    ? "refundRecorded"
                    : "paymentAllocated")
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
                        ? paymentMethodLabel(l, p.paymentMethod)
                        : t("payment")}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-[var(--cf-text)]">{formatZAR(p.amount)}</p>
                    <p className="text-[11px] text-[var(--cf-text-muted)]">{relativeTime(p.receivedAt, t, locale)}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </DataPanel>

      <DocumentsSummary documents={data.documents} t={t} l={l} />
      <InsuranceSection policies={data.insurancePolicies} t={t} l={l} />
    </div>
  )
}

function PaymentHero({
  firstName,
  greeting,
  nextSchedule,
  charges,
  t,
  l,
  locale,
}: {
  firstName: string
  greeting: string
  nextSchedule: { dueDate: Date; totalDue: number } | null | undefined
  charges: PortalCharges
  t: HomeT
  l: LabelsT
  locale: Locale
}) {
  const dueDays = nextSchedule ? daysUntil(nextSchedule.dueDate) : null

  return (
    <section className="rounded-lg border border-[var(--cf-border-strong)] bg-[linear-gradient(135deg,var(--cf-bg-raised),var(--cf-bg-panel))] p-6 md:p-8">
      <p className="text-sm text-[var(--cf-text-muted)]">{t("greetingWithName", { greeting, name: firstName })}</p>
      <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">{t("yourNextPayment")}</p>
      {nextSchedule ? (
        <>
          <p className="mt-1 text-4xl font-semibold text-[var(--cf-brand-soft)] md:text-5xl">{formatZAR(nextSchedule.totalDue + charges.outstanding)}</p>
          <ChargesBreakdown lines={charges.lines} className="mt-1" prefix={l("chargesIncludes")} />
          <p className="mt-2 text-sm text-[var(--cf-text-muted)]">
            {dueDays !== null && dueDays > 0
              ? (dueDays === 1 ? t("dueInOneDay") : t("dueInDays", { n: dueDays }))
              : dueDays === 0
                ? t("dueToday")
                : t("overdueByDays", { n: Math.abs(dueDays || 0) })}
            {" / "}
            {formatLongDay(nextSchedule.dueDate, locale)}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button asChild><Link href="/portal/payment">{t("payNow")}</Link></Button>
            <Button asChild variant="outline"><Link href="/portal/loans">{t("viewSchedule")}</Link></Button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-2xl font-semibold text-[var(--cf-text-muted)]">{t("noUpcomingPayments")}</p>
      )}
    </section>
  )
}

function ArrearsHero({ firstName, daysOverdue, outstanding, charges, whatsappE164, t, l }: {
  firstName: string
  daysOverdue: number
  outstanding: number
  charges: PortalCharges
  whatsappE164: string | null
  t: HomeT
  l: LabelsT
}) {
  return (
    <section className="rounded-lg border border-[rgba(208,92,75,0.42)] bg-[rgba(208,92,75,0.08)] p-6 md:p-8">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-[var(--cf-danger)]" />
        <p className="text-sm font-semibold text-[var(--cf-danger)]">{t("accountInArrears")}</p>
      </div>
      <p className="text-sm text-[var(--cf-text-secondary)]">
        {daysOverdue === 1 ? t("overdueOneDay", { name: firstName }) : t("overdueDays", { name: firstName, n: daysOverdue })}
      </p>
      <p className="mt-2 text-3xl font-semibold text-[var(--cf-text)] md:text-4xl">{formatZAR(outstanding)}</p>
      <p className="mt-1 text-sm text-[var(--cf-text-muted)]">{t("outstandingBalance")}</p>
      <ChargesBreakdown lines={charges.lines} className="mt-1" prefix={l("chargesIncludes")} />
      <div className="mt-5 flex flex-wrap gap-3">
        {whatsappE164 && (
          <Button asChild><a href={waHref(whatsappE164, "Hi, I need help with my overdue account")} target="_blank" rel="noopener noreferrer">{t("contactUs")}</a></Button>
        )}
        <Button asChild variant="outline"><Link href="/portal/payment">{t("makePayment")}</Link></Button>
      </div>
    </section>
  )
}

function StatCard({ t, label, value, sub, tone = "neutral" }: { t: HomeT; label: string; value: string; sub?: string; tone?: "success" | "danger" | "neutral" }) {
  return (
    <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-4">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">{label}</p>
      <p className="truncate text-lg font-semibold text-[var(--cf-text)]">{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-[var(--cf-text-muted)]">{sub}</p>}
      {tone !== "neutral" && <Badge variant={tone} className="mt-2">{t(tone === "success" ? "badgeClear" : "badgeActionNeeded")}</Badge>}
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

function DocumentsSummary({ documents, t, l }: { documents: Array<{ docType: string; verified: boolean }>; t: HomeT; l: LabelsT }) {
  const required = ["ID_COPY", "PAYSLIP", "BANK_STATEMENT", "PROOF_OF_ADDRESS"]
  const uploaded = documents.length
  const verified = documents.filter((d) => d.verified).length
  const missing = required.filter((r) => !documents.some((d) => d.docType === r))
  return (
    <DataPanel
      title={t("myDocuments")}
      actions={<Button asChild variant="ghost" size="sm"><Link href="/portal/documents">{t("manageDocuments")}</Link></Button>}
    >
      <div className="mb-3 flex items-center gap-6 text-sm text-[var(--cf-text-muted)]">
        <span>{t("uploaded")} <strong className="text-[var(--cf-text)]">{uploaded}</strong></span>
        <span>{t("verified")} <strong className="text-[var(--cf-success)]">{verified}</strong></span>
      </div>
      {missing.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-[rgba(217,154,58,0.24)] bg-[rgba(217,154,58,0.08)] p-3 text-sm text-[var(--cf-warning)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("missingDocs", { list: missing.map((m) => docTypeLabel(l, m)).join(", ") })}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-[rgba(63,191,127,0.24)] bg-[rgba(63,191,127,0.08)] p-3 text-sm text-[var(--cf-success)]">
          <CheckCircle className="h-4 w-4 shrink-0" />
          {t("allDocsUploaded")}
        </div>
      )}
    </DataPanel>
  )
}

function InsuranceSection({
  policies,
  t,
  l,
}: {
  t: HomeT
  l: LabelsT
  policies: Array<{
    id: string
    policyNumber: string
    status: string
    premiumAmount: number | bigint | { toNumber(): number }
    sumAssured: number | bigint | { toNumber(): number }
  }>
}) {
  return (
    <DataPanel title={t("myInsurance")}>
      {policies.length === 0 ? (
        <div className="py-6 text-center text-sm text-[var(--cf-text-muted)]">{t("noPolicies")}</div>
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
                    portal showed premiums 100× too small (R5 → "R 0.05"). */}
                <p className="mt-0.5 text-[12px] text-[var(--cf-text-muted)]">{t("coverage")} <span className="whitespace-nowrap">{formatZAR(Number(policy.sumAssured) * 100)}</span></p>
              </div>
              <div className="text-right">
                <Badge variant={getStatusTone(policy.status)}>{statusLabel(l, policy.status)}</Badge>
                <p className="mt-1 text-[12px] text-[var(--cf-text-muted)]"><span className="whitespace-nowrap">{formatZAR(Number(policy.premiumAmount) * 100)}</span>{t("perMonth")}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </DataPanel>
  )
}
