import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatZAR, formatDate } from "@/lib/utils"
import { redirect } from "next/navigation"
import { getPortalTenantId } from "@/lib/session-tenant"
import Link from "next/link"
import { FileText, AlertCircle, ArrowRight, Clock } from "lucide-react"
import type { AppStatus } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app-shell/EmptyState"

async function getApplications(email: string) {
  const tenantId = await getPortalTenantId()

  const client = await prisma.client.findFirst({ where: { email, tenantId } })
  if (!client) return { client: null, applications: [] }

  const applications = await prisma.loanApplication.findMany({
    where: { clientId: client.id, tenantId },
    include: { product: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  })

  return { client, applications }
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

const JOURNEY_STEPS: AppStatus[] = ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "DISBURSED"]

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

function ProgressStepper({ status }: { status: AppStatus }) {
  const activeIdx = JOURNEY_STEPS.indexOf(status)

  return (
    <div className="flex items-center gap-0 mt-4">
      {JOURNEY_STEPS.map((step, i) => {
        const isDone = activeIdx >= i
        const isCurrent = activeIdx === i
        const cfg = STATUS_CONFIG[step]
        const isLast = i === JOURNEY_STEPS.length - 1

        return (
          <div key={step} className="flex items-center flex-1">
            <div className="flex flex-col items-center flex-1">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border-2 transition-all"
                style={{
                  backgroundColor: isDone ? cfg.color : "transparent",
                  borderColor: isDone ? cfg.color : "#D1D5DB",
                  color: isDone ? "#fff" : "#9CA3AF",
                }}
              >
                {isDone ? "✓" : i + 1}
              </div>
              <p
                className="text-[9px] font-medium mt-1 text-center leading-tight"
                style={{ color: isDone ? (isCurrent ? cfg.color : "#6B7280") : "#9CA3AF" }}
              >
                {cfg.label}
              </p>
            </div>
            {!isLast && (
              <div
                className="h-0.5 flex-1 -mt-4"
                style={{ backgroundColor: activeIdx > i ? "#4F46E5" : "#E5E7EB" }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default async function ApplicationsPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const { client, applications } = await getApplications(session.user.email)

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 md:py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Applications</h1>
          <p className="text-sm text-gray-500 mt-0.5">Track the status of your loan applications</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Clock className="w-4 h-4" />
          <span>{applications.length} application{applications.length !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {!client ? (
        <EmptyState
          icon={FileText}
          title="No client account found"
          description="This portal login is not linked to a client profile yet. Contact support so we can connect your account."
          action={{ label: "Back to Overview", href: "/portal" }}
        />
      ) : applications.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No applications yet"
          description="Start a guided application and track review, documents, approval and agreement signing from here."
          action={{ label: "Apply Online", href: "/portal/apply" }}
          secondaryAction={
            <Button asChild variant="outline" size="sm">
              <Link href="/portal/documents">Upload Documents</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {applications.map((app) => {
            const needsSignature =
              app.status === "APPROVED" &&
              app.agreementGeneratedAt !== null &&
              app.agreementSignedAt === null

            return (
              <div
                key={app.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 hover:border-amber-200 transition-colors"
              >
                {/* Top row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-gray-900 text-sm">{app.reference}</p>
                      <StatusBadge status={app.status} />
                    </div>
                    <p className="text-sm text-gray-500 mt-0.5">{app.product.name}</p>
                  </div>
                  <Link
                    href={`/portal/applications/${app.id}`}
                    className="flex items-center gap-1 text-xs font-semibold shrink-0"
                    style={{ color: "#4F46E5" }}
                  >
                    Details <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>

                {/* Amount + date */}
                <div className="flex items-center gap-6 mt-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-gray-400">Applied Amount</p>
                    <p className="font-bold text-gray-900 text-sm">{formatZAR(app.appliedAmount)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-gray-400">Applied Date</p>
                    <p className="text-sm text-gray-700">{formatDate(app.createdAt)}</p>
                  </div>
                </div>

                {/* Progress stepper — only show for non-draft/cancelled */}
                {app.status !== "DRAFT" && app.status !== "CANCELLED" && (
                  <ProgressStepper status={app.status} />
                )}

                {/* Sign agreement alert */}
                {needsSignature && (
                  <div className="mt-4 flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                      <p className="text-sm font-medium text-amber-800">
                        Action Required: Sign your credit agreement
                      </p>
                    </div>
                    <Link
                      href={`/portal/agreement/${app.id}`}
                      className="text-xs font-bold whitespace-nowrap px-3 py-1.5 rounded-lg text-white"
                      style={{ backgroundColor: "#4F46E5" }}
                    >
                      Sign Now
                    </Link>
                  </div>
                )}

                {/* Decline reason */}
                {app.status === "DECLINED" && app.decisionReason && (
                  <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                    <p className="text-xs text-red-600 font-semibold mb-1">Decision reason</p>
                    <p className="text-sm text-red-700">{app.decisionReason}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
