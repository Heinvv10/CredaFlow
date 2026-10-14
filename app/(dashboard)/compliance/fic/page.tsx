import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireMinRole } from "@/lib/auth-guards"
import { getResolvedTenantId } from "@/lib/tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { loadCtrRegister, loadStrRegister, RECORDED_PAGE_SIZE, type CtrCandidate, type StrCaseRow } from "@/lib/fic/registers"
import { TIPPING_OFF_WARNING, logStrAccess } from "@/lib/fic/str-cases"
import { FIC_TOTP_ERROR, ficSessionNeedsTotp } from "@/lib/fic/session"
import { rmcpReviewState } from "@/lib/fic/rmcp"
import { CtrRegister } from "@/components/compliance/fic/CtrRegister"
import { StrRegister } from "@/components/compliance/fic/StrRegister"
import { RmcpPanel } from "@/components/compliance/fic/RmcpPanel"

export const dynamic = "force-dynamic"

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const ctrRow = (r: CtrCandidate) => ({ ...r, receivedAt: r.receivedAt.toISOString(), filedAt: iso(r.filedAt), recordedAt: iso(r.recordedAt) })
const strRow = (c: StrCaseRow) => ({
  id: c.id, reference: c.reference, kind: c.kind, status: c.status, raisedAt: c.raisedAt.toISOString(), raisedById: c.raisedById,
  clientId: c.clientId, clientName: c.clientName, loanReference: c.loanReference, grounds: c.grounds,
  assessmentNote: c.assessmentNote, fiuReference: c.fiuReference, reportedAt: iso(c.reportedAt),
})

/**
 * FIC Act tooling: the cash threshold register, the suspicious / unusual
 * transaction register (every render is a logged STR access), goAML-ready
 * draft exports, and the lender's RMCP. FIC compliance role, and a
 * TOTP-verified session where the lender requires staff 2FA.
 */
export default async function FicPage() {
  const user = await requireMinRole(PERMISSIONS.manage_fic_compliance)
  const tenantId = await getResolvedTenantId()
  if (user.tenantId !== tenantId) notFound()
  const breadcrumbs = <Breadcrumbs className="mb-4" items={[{ label: "Compliance", href: "/compliance" }, { label: "FIC Act" }]} />
  if (await ficSessionNeedsTotp(user, tenantId)) {
    return (
      <div className="p-6 lg:p-8 space-y-6">
        {breadcrumbs}
        <p className="rounded-md border border-[var(--cf-warning)] p-3 text-sm text-[var(--cf-warning)]" role="alert">{FIC_TOTP_ERROR}</p>
      </div>
    )
  }

  const [ctr, str, rmcp] = await Promise.all([
    loadCtrRegister(tenantId),
    loadStrRegister(tenantId),
    prisma.rmcpDocument.findMany({
      where: { tenantId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, title: true, fileName: true, uploadedById: true, uploadedAt: true, approvedAt: true, approvalNote: true, reviewDueAt: true },
    }),
  ])
  await logStrAccess(prisma, { tenantId, userId: user.id, action: "VIEW_REGISTER" })

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {breadcrumbs}
      <div>
        <h1 className="text-2xl font-semibold text-[var(--cf-text)]">FIC Act registers</h1>
        <p className="mt-2 rounded-md border border-[var(--cf-danger)] p-3 text-sm text-[var(--cf-danger)]" role="alert">
          {TIPPING_OFF_WARNING} Views of this page are logged.
        </p>
      </div>
      <CtrRegister
        unfiled={ctr.unfiled.map(ctrRow)}
        recorded={ctr.recorded.map(ctrRow)}
        recordedTotal={ctr.recordedTotal}
        pageSize={RECORDED_PAGE_SIZE}
        aggregates={ctr.aggregates}
      />
      <StrRegister
        open={str.open.map(strRow)}
        decided={str.decided.map(strRow)}
        decidedTotal={str.decidedTotal}
        viewerId={user.id}
      />
      <RmcpPanel
        viewerId={user.id}
        versions={rmcp.map((v) => ({
          ...v, uploadedAt: v.uploadedAt.toISOString(), approvedAt: iso(v.approvedAt),
          reviewDueAt: v.reviewDueAt.toISOString().slice(0, 10), reviewState: rmcpReviewState(v.reviewDueAt),
        }))}
      />
    </div>
  )
}
