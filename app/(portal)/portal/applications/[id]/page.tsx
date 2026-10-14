import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatZAR, formatDate, formatTermDays } from "@/lib/utils"
import { redirect, notFound } from "next/navigation"
import { getPortalTenantId } from "@/lib/session-tenant"
import Link from "next/link"
import { AlertCircle, CheckCircle, Clock } from "lucide-react"
import { BackLink } from "@/components/nav/BackLink"
import type { AppStatus } from "@prisma/client"
import { portalDecisionLabel } from "@/lib/applications/decision-kind"
import { ExecutedAgreementCard } from "@/components/portal/ExecutedAgreementCard"
import { PasqAcknowledgementCard } from "@/components/portal/PasqAcknowledgementCard"
import {
  portalApplicationNextStep,
  portalPasqAcknowledged,
  portalPasqOnScreen,
} from "@/lib/portal/application-next-step"

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

const STATUS_CONFIG: Record<AppStatus, { label: string; bg: string; color: string }> = {
  DRAFT:        { label: "Draft",        bg: "#F3F4F6", color: "#6B7280" },
  SUBMITTED:    { label: "Submitted",    bg: "#DBEAFE", color: "#1E40AF" },
  UNDER_REVIEW: { label: "Under Review", bg: "#FEF9C3", color: "#92400E" },
  APPROVED:     { label: "Approved",     bg: "#DCFCE7", color: "#166534" },
  DECLINED:     { label: "Declined",     bg: "#FEE2E2", color: "#991B1B" },
  DISBURSED:    { label: "Disbursed",    bg: "#EDE9FE", color: "#5B21B6" },
  CANCELLED:    { label: "Cancelled",    bg: "#F3F4F6", color: "#6B7280" },
}

interface TimelineEvent {
  label: string
  date: Date
  done: boolean
}

type AppDetail = NonNullable<Awaited<ReturnType<typeof getApplicationDetail>>>["application"]

function buildTimeline(app: AppDetail): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { label: "Application submitted", date: app.submittedAt ?? app.createdAt, done: true },
  ]

  if (app.incomeVerifiedAt) {
    events.push({ label: "Income verified / Under review", date: app.incomeVerifiedAt, done: true })
  } else if (["UNDER_REVIEW", "APPROVED", "DECLINED", "DISBURSED"].includes(app.status)) {
    events.push({ label: "Under review", date: app.updatedAt, done: true })
  }

  if (app.pasqGeneratedAt) {
    events.push({ label: "PASQ generated", date: app.pasqGeneratedAt, done: true })
  }

  if (app.pasqAcknowledgedAt && app.pasqAcknowledgedSha256 === app.pasqDocumentSha256) {
    events.push({ label: "PASQ acknowledged", date: app.pasqAcknowledgedAt, done: true })
  }

  const decisionLabel = portalDecisionLabel(app)
  if (app.approvedAt && decisionLabel) {
    events.push({
      label: decisionLabel,
      date: app.approvedAt,
      done: true,
    })
  }

  if (app.agreementGeneratedAt) {
    events.push({ label: "Credit agreement generated", date: app.agreementGeneratedAt, done: true })
  }

  if (app.agreementSignedAt) {
    events.push({ label: "Credit agreement signed", date: app.agreementSignedAt, done: true })
  }

  if (app.debitMandatePreparedAt) {
    events.push({ label: "Debit mandate prepared", date: app.debitMandatePreparedAt, done: true })
  }

  if (app.debitMandateSignedAt) {
    events.push({ label: "Debit mandate signed", date: app.debitMandateSignedAt, done: true })
  }

  if (app.disbursedAt) {
    events.push({ label: "Loan disbursed", date: app.disbursedAt, done: true })
  }

  return events.sort((a, b) => a.date.getTime() - b.date.getTime())
}

function StatusBadge({ status }: { status: AppStatus }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span
      style={{ background: cfg.bg, color: cfg.color }}
      className="inline-block px-2.5 py-0.5 rounded text-[11px] font-semibold"
    >
      {cfg.label}
    </span>
  )
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

  const timeline = buildTimeline(app)
  const nextStep = portalApplicationNextStep(app)

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 md:py-8">
      {/* Back */}
      <BackLink href="/portal/applications" label="Back to Applications" className="mb-5" />

      {/* Hero card */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 mb-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">Reference</p>
            <p className="text-xl font-bold text-gray-900">{app.reference}</p>
            <p className="text-sm text-gray-500 mt-0.5">{app.product.name}</p>
          </div>
          <StatusBadge status={app.status} />
        </div>

        {/* Key details grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5 pt-5 border-t border-gray-100">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Applied Amount</p>
            <p className="font-bold text-gray-900">{formatZAR(app.appliedAmount)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Term</p>
            <p className="font-bold text-gray-900">{formatTermDays(app.appliedTermDays)}</p>
          </div>
          {app.approvedAmount && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Approved Amount</p>
              <p className="font-bold" style={{ color: "#166534" }}>{formatZAR(app.approvedAmount)}</p>
            </div>
          )}
          {app.purpose && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Purpose</p>
              <p className="font-bold text-gray-900 text-sm truncate">{app.purpose}</p>
            </div>
          )}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Submitted</p>
            <p className="text-sm text-gray-700">{formatDate(app.submittedAt ?? app.createdAt)}</p>
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
            <p className="font-semibold text-blue-800 text-sm">What happens next</p>
            <p className="text-xs text-blue-700 mt-0.5">
              Your application is under review. We&apos;ll contact you within 2 business days. No action is required from you right now — keep an eye on your email and WhatsApp.
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
              <p className="font-semibold text-amber-800 text-sm">Action Required</p>
              <p className="text-xs text-amber-700">Your loan has been approved. Please sign your credit agreement to proceed.</p>
            </div>
          </div>
          <Link
            href={`/portal/agreement/${app.id}`}
            className="px-4 py-2 rounded-lg text-white font-bold text-sm whitespace-nowrap"
            style={{ backgroundColor: "#4F46E5" }}
          >
            Sign Agreement
          </Link>
        </div>
      )}

      {needsMandate && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Action Required</p>
              <p className="text-xs text-amber-700">
                Confirm your repayment bank details and sign the debit mandate before disbursement.
              </p>
            </div>
          </div>
          <Link
            href={`/portal/mandate/${app.id}`}
            className="whitespace-nowrap rounded-lg px-4 py-2 text-sm font-bold text-white"
            style={{ backgroundColor: "#4F46E5" }}
          >
            Set Up Repayment
          </Link>
        </div>
      )}

      <ExecutedAgreementCard agreementExecutedDocumentId={app.agreementExecutedDocumentId} />

      {/* Declined reason */}
      {app.status === "DECLINED" && app.decisionReason && (
        <div className="mb-5 bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-red-800 mb-1">Reason for Decision</p>
          <p className="text-sm text-red-700">{app.decisionReason}</p>
        </div>
      )}

      {/* Active loan link */}
      {loan && (
        <div className="mb-5 bg-green-50 border border-green-200 rounded-xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
            <div>
              <p className="font-semibold text-green-800 text-sm">Loan Active</p>
              <p className="text-xs text-green-700">Reference: {loan.reference}</p>
            </div>
          </div>
          <Link
            href={`/portal/loans/${loan.id}`}
            className="px-4 py-2 rounded-lg text-white font-bold text-sm whitespace-nowrap"
            style={{ backgroundColor: "#166534" }}
          >
            View Loan
          </Link>
        </div>
      )}

      {/* Timeline */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h2 className="font-bold text-gray-900 text-sm mb-4">Application Timeline</h2>
        <div className="space-y-0">
          {timeline.map((event, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="flex flex-col items-center">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                  style={{ backgroundColor: event.done ? "#DCFCE7" : "#F3F4F6" }}
                >
                  {event.done ? (
                    <CheckCircle className="w-3.5 h-3.5 text-green-600" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 text-gray-400" />
                  )}
                </div>
                {i < timeline.length - 1 && (
                  <div className="w-px flex-1 bg-gray-200 mt-1 mb-1 min-h-[20px]" />
                )}
              </div>
              <div className="pb-4 min-w-0">
                <p className="text-sm font-medium text-gray-800">{event.label}</p>
                <p className="text-xs text-gray-400 mt-0.5">{formatDate(event.date)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
