import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireMinRole } from "@/lib/auth-guards"
import { getResolvedTenantId } from "@/lib/tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { listCtrCandidates, listStrCases } from "@/lib/fic/registers"
import { TIPPING_OFF_WARNING, logStrAccess } from "@/lib/fic/str-cases"
import { rmcpReviewState } from "@/lib/fic/rmcp"
import { CtrRegister } from "@/components/compliance/fic/CtrRegister"
import { StrRegister } from "@/components/compliance/fic/StrRegister"
import { RmcpPanel } from "@/components/compliance/fic/RmcpPanel"

export const dynamic = "force-dynamic"

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/**
 * FIC Act tooling: the cash threshold register, the suspicious / unusual
 * transaction register (every render is a logged STR access), goAML-ready
 * draft exports, and the lender's RMCP. FIC compliance role only.
 */
export default async function FicPage() {
  const user = await requireMinRole(PERMISSIONS.manage_fic_compliance)
  const tenantId = await getResolvedTenantId()
  if (user.tenantId !== tenantId) notFound()

  const [ctr, str, rmcp] = await Promise.all([
    listCtrCandidates(tenantId),
    listStrCases(tenantId),
    prisma.rmcpDocument.findMany({
      where: { tenantId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, title: true, fileName: true, uploadedAt: true, approvedAt: true, approvalNote: true, reviewDueAt: true },
    }),
  ])
  await logStrAccess(prisma, { tenantId, userId: user.id, action: "VIEW_REGISTER" })

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Breadcrumbs className="mb-4" items={[{ label: "Compliance", href: "/compliance" }, { label: "FIC Act" }]} />
      <div>
        <h1 className="text-2xl font-semibold text-[var(--cf-text)]">FIC Act registers</h1>
        <p className="mt-2 rounded-md border border-[var(--cf-danger)] p-3 text-sm text-[var(--cf-danger)]" role="alert">
          {TIPPING_OFF_WARNING} Views of this page are logged.
        </p>
      </div>
      <CtrRegister
        rows={ctr.map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString(), filedAt: iso(r.filedAt), recordedAt: iso(r.recordedAt) }))}
      />
      <StrRegister
        cases={str.map((c) => ({
          id: c.id, reference: c.reference, kind: c.kind, status: c.status, raisedAt: c.raisedAt.toISOString(),
          clientId: c.clientId, clientName: c.clientName, loanReference: c.loanReference, grounds: c.grounds,
          assessmentNote: c.assessmentNote, fiuReference: c.fiuReference, reportedAt: iso(c.reportedAt),
        }))}
      />
      <RmcpPanel
        versions={rmcp.map((v) => ({
          ...v, uploadedAt: v.uploadedAt.toISOString(), approvedAt: iso(v.approvedAt),
          reviewDueAt: v.reviewDueAt.toISOString().slice(0, 10), reviewState: rmcpReviewState(v.reviewDueAt),
        }))}
      />
    </div>
  )
}
