import { ApplicationsWorkspace } from "@/components/applications/ApplicationsWorkspace"
import { AuditAction } from "@/lib/audit"
import {
  latestRefusalByApplication,
  type PipelineApplication,
} from "@/lib/applications/pipeline-view"
import { readApplicationReadiness } from "@/lib/applications/readiness-data"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { sastMonthBounds } from "@/lib/compliance/quarters"

async function getApplications() {
  const now = new Date()
  // SAST boundary: the container has no TZ, so date parts resolve in UTC and
  // land two hours inside the previous South African day.
  const monthStart = sastMonthBounds(now).start
  const tenantId = await getDefaultTenantId()

  const [applications, monthlyCount, refusals, readiness] = await Promise.all([
    prisma.loanApplication.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        reference: true,
        status: true,
        appliedAmount: true,
        createdAt: true,
        submittedAt: true,
        approvedAt: true,
        disbursedAt: true,
        updatedAt: true,
        client: { select: { firstName: true, lastName: true } },
        product: { select: { name: true, productType: true } },
        branch: { select: { name: true } },
        assignedTo: { select: { name: true } },
      },
    }),
    prisma.loanApplication.count({
      where: { tenantId, createdAt: { gte: monthStart } },
    }),
    // Refused payouts, newest first — `latestRefusalByApplication` takes the
    // first row it sees per application as the current reason and counts the
    // rest. Unbounded in principle; 28 rows across four applications on
    // production at the time of writing, and it grows only when a payout is
    // refused. If it ever gets large, narrow it by application id rather than
    // by date — an application blocked for a fortnight is exactly the one that
    // must still show a badge.
    prisma.auditLog.findMany({
      where: { tenantId, action: AuditAction.LOAN_DISBURSEMENT_REFUSED },
      orderBy: { createdAt: "desc" },
      select: { entityId: true, createdAt: true, newValue: true },
    }),
    // One pass for the whole board — six queries however many cards there are,
    // and only for the three statuses that draw a chip.
    readApplicationReadiness(tenantId),
  ])

  const refusalByApplication = latestRefusalByApplication(refusals)

  const pipeline: PipelineApplication[] = applications.map((app) => ({
    ...app,
    payoutRefusal: refusalByApplication.get(app.id) ?? null,
    readiness: readiness.get(app.id) ?? null,
  }))

  return { applications: pipeline, monthlyCount }
}

export default async function ApplicationsPage() {
  const { applications, monthlyCount } = await getApplications()

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col p-4 lg:p-8">
      <ApplicationsWorkspace applications={applications} monthlyCount={monthlyCount} />
    </div>
  )
}
