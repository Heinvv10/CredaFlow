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
import { formatZAR } from "@/lib/utils"
import { getPortalTenantId } from "@/lib/session-tenant"
import { getLocale } from "@/lib/i18n/server"
import { createTranslator, type Translator } from "@/lib/i18n/translate"
import { formatDay } from "@/lib/i18n/format"
import { paymentMethodLabel, statusLabel } from "@/lib/i18n/portal-labels"
import type { Locale } from "@/lib/i18n/locales"

type StatementT = Translator<"portalStatement">

/**
 * reversalDetailLine (lib/payments/reversal-label.ts), translated. The shared
 * helper stays English because the statement PDF uses it.
 */
function reversalDetail(
  t: StatementT,
  locale: Locale,
  p: { reversed?: boolean; reversedAt?: Date | null; reversalReason?: string | null },
): string | null {
  if (!p.reversed) return null
  const when = p.reversedAt ? t("reversedOn", { date: formatDay(new Date(p.reversedAt), locale) }) : t("reversedPlain")
  const reason = p.reversalReason?.trim()
  return reason ? t("reversedWithReason", { when, reason }) : when
}

export default async function StatementPage() {
  const session = await auth()
  if (!session?.user) redirect("/portal/login")

  const tenantId = await getPortalTenantId()
  const locale = await getLocale()
  const t = createTranslator(locale, "portalStatement")
  const l = createTranslator(locale, "portalLabels")

  const client = await prisma.client.findFirst({ where: { email: session.user.email!, tenantId } })
  if (!client) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
        <EmptyState
          icon={FileText}
          title={t("noClientTitle")}
          description={t("noClientDesc")}
          action={{ label: t("backToOverview"), href: "/portal" }}
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
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">{t("eyebrow")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
          {t("desc")}
        </p>
      </div>

      {loans.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title={t("noLoansTitle")}
          description={t("noLoansDesc")}
          action={{ label: t("startApplication"), href: "/portal/apply" }}
          secondaryAction={
            <Button asChild variant="outline" size="sm">
              <Link href="/portal/documents">{t("manageDocuments")}</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {loans.map((loan) => (
            <DataPanel
              key={loan.id}
              title={loan.reference}
              description={`${loan.product.name} / ${statusLabel(l, loan.status)}`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm">
                    <a href={`/api/loans/${loan.id}/statement`} target="_blank" rel="noopener noreferrer">
                      <Download className="h-3.5 w-3.5" />
                      {t("pdf")}
                    </a>
                  </Button>
                  <PrintButton />
                </div>
              }
            >
              <div className="mb-4 rounded-lg border border-[rgba(79,70,229,0.28)] bg-[rgba(79,70,229,0.06)] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">{t("paymentReference")}</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-[var(--cf-brand)]">{loan.reference}</p>
                <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">
                  {t("quoteReference")}
                </p>
              </div>

              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">{t("outstanding")}</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--cf-text)]">{formatZAR(loan.outstandingPrincipal)}</p>
                </div>
                <div className="rounded-lg border border-[rgba(63,191,127,0.24)] bg-[rgba(63,191,127,0.08)] p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">{t("totalPaid")}</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--cf-success)]">{formatZAR(loan.totalPaid)}</p>
                </div>
                <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">{t("totalRepayable")}</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--cf-text)]">{formatZAR(loan.totalRepayable)}</p>
                </div>
              </div>

              {loan.payments.length === 0 ? (
                <EmptyState
                  icon={CreditCard}
                  title={t("noPaymentsTitle")}
                  description={t("noPaymentsDesc")}
                  action={{ label: t("makePayment"), href: "/portal/payment" }}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colDate")}</TableHead>
                      <TableHead>{t("colAmount")}</TableHead>
                      <TableHead>{t("colMethod")}</TableHead>
                      <TableHead>{t("colReference")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loan.payments.map((payment) => {
                      const method = paymentMethodLabel(l, payment.paymentMethod)
                      const reversalLine = reversalDetail(t, locale, payment)
                      const allocationDetail =
                        payment.allocationStatus === "UNAPPLIED"
                          ? t("allocationPendingDetail")
                          : payment.allocationStatus === "REFUNDED"
                            ? t("refundedDetail")
                            : null
                      const inactive =
                        payment.reversed || payment.allocationStatus !== "ALLOCATED"
                      return (
                        <TableRow
                          key={payment.id}
                          className={inactive ? "opacity-70" : undefined}
                          title={reversalLine ?? allocationDetail ?? undefined}
                        >
                          <TableCell>{formatDay(payment.receivedAt, locale)}</TableCell>
                          <TableCell className={`font-medium ${inactive ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"} ${payment.reversed ? "line-through" : ""}`}>{formatZAR(payment.amount)}</TableCell>
                          <TableCell className="capitalize">
                            {payment.reversed ? t("reversedMarker", { method }) : method}
                            {!payment.reversed && payment.allocationStatus !== "ALLOCATED"
                              ? ` / ${payment.allocationStatus === "UNAPPLIED" ? t("allocation_UNAPPLIED") : t("allocation_REFUNDED")}`
                              : ""}
                            {reversalLine && (
                              <span className="mt-0.5 block text-[11px] normal-case text-[var(--cf-text-muted)]">
                                {reversalLine}
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
