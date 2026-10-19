import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowRight, Wallet } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatZAR } from "@/lib/utils"
import { getStatusTone } from "@/lib/status-style"
import { getPortalTenantId } from "@/lib/session-tenant"
import { cashReceivedCents } from "@/lib/payments/waiver"
import { getLocale } from "@/lib/i18n/server"
import { createTranslator } from "@/lib/i18n/translate"
import { formatDay } from "@/lib/i18n/format"
import { productNameLabel, statusLabel } from "@/lib/i18n/portal-labels"

export default async function PortalLoansPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const tenantId = await getPortalTenantId()
  const locale = await getLocale()
  const t = createTranslator(locale, "portalLoans")
  const l = createTranslator(locale, "portalLabels")

  const client = await prisma.client.findFirst({
    where: { email: session.user.email, tenantId },
    select: { id: true },
  })

  if (!client) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
        <EmptyState
          icon={Wallet}
          title={t("noClientRecord")}
          description={t("notLinked")}
          action={{ label: t("backToOverview"), href: "/portal" }}
        />
      </div>
    )
  }

  const loans = await prisma.loan.findMany({
    where: { clientId: client.id, tenantId },
    include: {
      product: { select: { name: true } },
      payments: { select: { amount: true, paymentMethod: true, reversed: true, allocationStatus: true } },
    },
    orderBy: { startDate: "desc" },
  })

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6 md:py-8">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">{createTranslator(locale, "portalShell")("clientPortal")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">{t("myLoans")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
          {t("myLoansDesc")}
        </p>
      </div>

      {loans.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title={t("noLoansTitle")}
          description={t("noLoansDesc")}
          action={{ label: t("startApplication"), href: "/portal/apply" }}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {loans.map((loan) => (
            <DataPanel
              key={loan.id}
              title={loan.reference}
              description={t("loanCardDesc", { product: productNameLabel(l, loan.product.name), date: formatDay(loan.startDate, locale) })}
              actions={<Badge variant={getStatusTone(loan.status)}>{statusLabel(l, loan.status)}</Badge>}
            >
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Metric label={t("outstanding")} value={formatZAR(loan.outstandingPrincipal)} />
                <Metric label={t("totalPaid")} value={formatZAR(cashReceivedCents(loan.payments))} />
                <Metric label={t("totalRepayable")} value={formatZAR(loan.totalRepayable)} />
                <Metric label={t("nextPayment")} value={loan.nextPaymentDate ? formatDay(loan.nextPaymentDate, locale) : t("notApplicable")} />
              </div>
              <div className="mt-5 flex justify-end">
                <Button asChild size="sm">
                  <Link href={`/portal/loans/${loan.id}`}>
                    {t("viewSchedule")}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </DataPanel>
          ))}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">{label}</p>
      <p className="whitespace-nowrap mt-1 font-semibold text-[var(--cf-text)]">{value}</p>
    </div>
  )
}
