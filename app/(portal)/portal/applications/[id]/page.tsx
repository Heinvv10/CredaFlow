import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatZAR } from "@/lib/utils"
import { redirect, notFound } from "next/navigation"
import { getPortalTenantId } from "@/lib/session-tenant"
import Link from "next/link"
import { AlertCircle, CheckCircle, Clock } from "lucide-react"
import { BackLink } from "@/components/nav/BackLink"
import type { DeclineCategory } from "@prisma/client"
import { getLenderIdentity } from "@/lib/config/identity"
import { DeclineDecisionCard } from "@/components/portal/DeclineDecisionCard"
import { loadPortalDeclineView } from "@/lib/portal/decline-view"
import {
  buildApplicationTimeline,
  portalApplicationStatus,
  type PortalApplicationStatus,
} from "@/lib/portal/application-view"
import { ExecutedAgreementCard } from "@/components/portal/ExecutedAgreementCard"
import { PasqAcknowledgementCard } from "@/components/portal/PasqAcknowledgementCard"
import {
  portalApplicationNextStep,
  portalPasqAcknowledged,
  portalPasqOnScreen,
} from "@/lib/portal/application-next-step"
import { getLocale } from "@/lib/i18n/server"
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate"
import { formatDay } from "@/lib/i18n/format"

async function getApplicationDetail(id: string, email: string) {
  const tenantId = await getPortalTenantId()

  const client = await prisma.client.findFirst({ where: { email, tenantId } })
  if (!client) return null

  const application = await prisma.loanApplication.findFirst({
    where: { id, tenantId },
    include: { product: { select: { name: true, id: true } } },
  })

  if (!application || application.clientId !== client.id) return null

  const loan = await prisma.loan.findFirst({
    where: { applicationId: id, tenantId },
    select: { id: true, reference: true, status: true },
  })

  return { application, loan }
}

type AppsT = Translator<"portalApplications">

async function loadDeclineView(app: { id: string; tenantId: string; declineCategory: DeclineCategory | null; decisionReason: string | null }) {
  const identity = await getLenderIdentity(app.tenantId)
  return loadPortalDeclineView(prisma, app.tenantId, app, { phone: identity.publicPhone, email: identity.publicEmail })
}

const STATUS_CONFIG: Record<PortalApplicationStatus, { label: MessageKey<"portalApplications">; bg: string; color: string }> = {
  DRAFT:        { label: "appStatus_DRAFT",        bg: "#F3F4F6", color: "#6B7280" },
  SUBMITTED:    { label: "appStatus_SUBMITTED",    bg: "#DBEAFE", color: "#1E40AF" },
  UNDER_REVIEW: { label: "appStatus_UNDER_REVIEW", bg: "#FEF9C3", color: "#92400E" },
  APPROVED:     { label: "appStatus_APPROVED",     bg: "#DCFCE7", color: "#166534" },
  DECLINED:     { label: "appStatus_DECLINED",     bg: "#FEE2E2", color: "#991B1B" },
  DISBURSED:    { label: "appStatus_DISBURSED",    bg: "#EDE9FE", color: "#5B21B6" },
  CANCELLED:    { label: "appStatus_CANCELLED",    bg: "#F3F4F6", color: "#6B7280" },
  SETTLED:      { label: "appStatus_SETTLED",      bg: "#DBEAFE", color: "#1D4ED8" },
}

function StatusBadge({ status, t }: { status: PortalApplicationStatus; t: AppsT }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span
      style={{ background: cfg.bg, color: cfg.color }}
      className="inline-block px-2.5 py-0.5 rounded text-[11px] font-semibold"
    >
      {t(cfg.label)}
    </span>
  )
}

/** formatTermDays (lib/utils), translated: 30 days = 1 month. */
function termLabel(t: AppsT, days: number): string {
  const months = Math.round(days / 30)
  if (months < 1) return days === 1 ? t("termOneDay") : t("termDays", { n: days })
  return months === 1 ? t("termOneMonth") : t("termMonths", { n: months })
}

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const { id } = await params
  const data = await getApplicationDetail(id, session.user.email)

  if (!data) notFound()

  const { application: app, loan } = data

  const needsSignature =
    app.status === "APPROVED" &&
    app.agreementGeneratedAt !== null &&
    app.agreementSignedAt === null
  const needsMandate =
    app.status === "APPROVED"
    && app.repaymentMethod !== "EFT"
    && app.agreementSignedAt !== null
    && app.debitMandateSignedAt === null

  const timeline = buildApplicationTimeline(app)
  const nextStep = portalApplicationNextStep(app)
  const locale = await getLocale()
  const t = createTranslator(locale, "portalApplications")
  const status = portalApplicationStatus(app.status, loan?.status)
  const declineView = app.status === "DECLINED"
    ? await loadDeclineView(app)
    : null

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 md:py-8">
      {/* Back */}
      <BackLink href="/portal/applications" label={t("backToApplications")} className="mb-5" />

      {/* Hero card */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 mb-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">{t("reference")}</p>
            <p className="text-xl font-bold text-gray-900">{app.reference}</p>
            <p className="text-sm text-gray-500 mt-0.5">{app.product.name}</p>
          </div>
          <StatusBadge status={status} t={t} />
        </div>

        {/* Key details grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5 pt-5 border-t border-gray-100">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{t("appliedAmount")}</p>
            <p className="font-bold text-gray-900">{formatZAR(app.appliedAmount)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{t("term")}</p>
            <p className="font-bold text-gray-900">{termLabel(t, app.appliedTermDays)}</p>
          </div>
          {app.approvedAmount && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{t("approvedAmount")}</p>
              <p className="font-bold" style={{ color: "#166534" }}>{formatZAR(app.approvedAmount)}</p>
            </div>
          )}
          {app.purpose && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{t("purpose")}</p>
              <p className="font-bold text-gray-900 text-sm truncate">{app.purpose}</p>
            </div>
          )}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{t("submitted")}</p>
            <p className="text-sm text-gray-700">{formatDay(app.submittedAt ?? app.createdAt, locale)}</p>
          </div>
        </div>
      </div>

      {/* What happens next — in-flight statuses. The other statuses
         (APPROVED+needsSig, DECLINED, DISBURSED) are covered by the
         existing banners below; DRAFT is not-yet-submitted and CANCELLED
         is terminal — neither benefits from a "next step" hint. While a
         PASQ awaits the consumer's acknowledgement the card below IS the
         next step, so this "no action required" reassurance must not
         render alongside it. */}
      {nextStep === "review_wait" && (
        <div className="mb-5 bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-start gap-3">
          <Clock className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-blue-800 text-sm">{t("whatHappensNext")}</p>
            <p className="text-xs text-blue-700 mt-0.5">
              {t("reviewWait")}
            </p>
          </div>
        </div>
      )}

      {portalPasqOnScreen(app) && app.pasqDocumentSha256 && (
        <PasqAcknowledgementCard
          applicationId={app.id}
          documentSha256={app.pasqDocumentSha256}
          acknowledged={portalPasqAcknowledged(app)}
        />
      )}

      {/* Sign agreement alert */}
      {needsSignature && (
        <div className="mb-5 bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <p className="font-semibold text-amber-800 text-sm">{t("actionRequired")}</p>
              <p className="text-xs text-amber-700">{t("approvedSignPrompt")}</p>
            </div>
          </div>
          <Link
            href={`/portal/agreement/${app.id}`}
            className="px-4 py-2 rounded-lg text-white font-bold text-sm whitespace-nowrap"
            style={{ backgroundColor: "#4F46E5" }}
          >
            {t("signAgreement")}
          </Link>
        </div>
      )}

      {needsMandate && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-amber-800">{t("actionRequired")}</p>
              <p className="text-xs text-amber-700">
                {t("mandatePrompt")}
              </p>
            </div>
          </div>
          <Link
            href={`/portal/mandate/${app.id}`}
            className="whitespace-nowrap rounded-lg px-4 py-2 text-sm font-bold text-white"
            style={{ backgroundColor: "#4F46E5" }}
          >
            {t("setUpRepayment")}
          </Link>
        </div>
      )}

      <ExecutedAgreementCard agreementExecutedDocumentId={app.agreementExecutedDocumentId} locale={locale} />

      {/* Declined: the NCA decision record, kept in English in every locale */}
      {declineView && <DeclineDecisionCard view={declineView} />}

      {/* Active loan link */}
      {loan && (
        <div className="mb-5 bg-green-50 border border-green-200 rounded-xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
            <div>
              <p className="font-semibold text-green-800 text-sm">{t(status === "SETTLED" ? "loanSettled" : "loanActive")}</p>
              <p className="text-xs text-green-700">{t("loanReference", { reference: loan.reference })}</p>
            </div>
          </div>
          <Link
            href={`/portal/loans/${loan.id}`}
            className="px-4 py-2 rounded-lg text-white font-bold text-sm whitespace-nowrap"
            style={{ backgroundColor: "#166534" }}
          >
            {t("viewLoan")}
          </Link>
        </div>
      )}

      {/* Timeline */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h2 className="font-bold text-gray-900 text-sm mb-4">{t("timeline")}</h2>
        <div className="space-y-0">
          {timeline.map((event, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="flex flex-col items-center">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                  style={{ backgroundColor: "#DCFCE7" }}
                >
                  <CheckCircle className="w-3.5 h-3.5 text-green-600" />
                </div>
                {i < timeline.length - 1 && (
                  <div className="w-px flex-1 bg-gray-200 mt-1 mb-1 min-h-[20px]" />
                )}
              </div>
              <div className="pb-4 min-w-0">
                <p className="text-sm font-medium text-gray-800">{t(event.label)}</p>
                <p className="text-xs text-gray-400 mt-0.5">{formatDay(event.date, locale)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
