import type { CollectionBatchStatus } from "@prisma/client"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { getStaffTenantId } from "@/lib/session-tenant"
import { formatDate, formatZAR } from "@/lib/utils"
import { loadBatchList } from "@/lib/collections-engine/view.server"
import { getSession } from "@/lib/auth-session"
import { hasMinRole } from "@/lib/auth-guards"
import { ReviewList } from "@/components/collections-engine/ReviewList"

const TONE: Record<CollectionBatchStatus, "warning" | "success" | "danger" | "info"> = {
  SUBMITTING: "warning",
  UPLOADED: "info",
  SUBMITTED: "success",
  FAILED: "danger",
  NEEDS_REVIEW: "warning",
}

/** Collections engine: every batch submitted to the provider, newest first. */
export default async function CollectionBatchesPage() {
  const tenantId = await getStaffTenantId()
  const [view, session] = await Promise.all([loadBatchList(tenantId), getSession()])
  const canManage = session?.user?.role ? hasMinRole(session.user.role, "LOAN_ADMIN") : false
  const batches = view?.batches ?? null

  return (
    <div className="space-y-6 p-4 lg:p-8">
      <Breadcrumbs items={[{ label: "Collections", href: "/collections" }, { label: "Debit order batches" }]} />
      {batches === null ? (
        <InfoStrip>The DebiCheck collections engine is off for this lender (Settings → Integrations → Collections).</InfoStrip>
      ) : (
        <>
        <DataPanel title="Needs review" description="Debits, results and mandates the engine will not decide alone" variant="default" density="loose">
          <ReviewList queue={view!.review} canManage={canManage} showLoan />
        </DataPanel>
        <DataPanel title="Debit order batches" description="The latest 100 submissions to the collection provider" variant="default" density="loose">
          {batches.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">No batches submitted yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--cf-text-muted)]">
                    <th className="py-1 pr-3 font-medium">Action date</th>
                    <th className="py-1 pr-3 font-medium">Provider</th>
                    <th className="py-1 pr-3 font-medium">Reference</th>
                    <th className="py-1 pr-3 text-right font-medium">Instructions</th>
                    <th className="py-1 pr-3 text-right font-medium">Accepted / rejected</th>
                    <th className="py-1 pr-3 text-right font-medium">Total</th>
                    <th className="py-1 pl-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="border-t border-[var(--cf-border-subtle)] align-top">
                      <td className="py-1.5">{formatDate(b.actionDate)}</td>
                      <td className="py-1.5">{b.provider}</td>
                      <td className="py-1.5 font-mono text-xs">{b.providerBatchRef ?? "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{b.instructionCount}</td>
                      <td className="py-1.5 text-right tabular-nums">{b.acceptedCount} / {b.rejectedCount}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatZAR(b.totalCents)}</td>
                      <td className="py-1.5 pl-3">
                        <StatusPill tone={TONE[b.status]}>{b.status.toLowerCase()}</StatusPill>
                        {b.simulated && <StatusPill tone="warning" className="ml-2">Simulated</StatusPill>}
                        {b.error && <p className="mt-1 whitespace-normal text-xs text-[var(--cf-danger)]">{b.error}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataPanel>
        </>
      )}
    </div>
  )
}
