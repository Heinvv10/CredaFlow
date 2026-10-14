import { notFound } from "next/navigation"
import { requireMinRole, hasMinRole } from "@/lib/auth-guards"
import { getResolvedTenantId } from "@/lib/tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { getScreeningConfig } from "@/lib/screening/policy"
import { listActiveBlocks, listReviewQueue } from "@/lib/screening/queue"
import { listScreeningProviders } from "@/lib/screening/registry"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { ScreeningReviewQueue } from "@/components/compliance/ScreeningReviewQueue"
import { ScreeningBlocksPanel } from "@/components/compliance/ScreeningBlocksPanel"
import { ScreeningSettingsForm } from "@/components/compliance/ScreeningSettingsForm"

export const dynamic = "force-dynamic"

/**
 * PEP / sanctions screening: the review queue (undecided matches in each
 * party's latest run), sticky blocks, and for a SUPER_ADMIN the lift action
 * and the lender's screening settings. BRANCH_MANAGER is the floor; the
 * routes apply the lender's own minimum role, 2FA policy and maker-checker.
 */
export default async function ScreeningPage() {
  const user = await requireMinRole("BRANCH_MANAGER")
  const tenantId = await getResolvedTenantId()
  if (user.tenantId !== tenantId) notFound()

  const [config, queue, blocks] = await Promise.all([getScreeningConfig(tenantId), listReviewQueue(tenantId), listActiveBlocks(tenantId)])
  const providers = listScreeningProviders().filter((p) => !p.simulated || isSimulationPermitted("screening"))
  const superAdmin = hasMinRole(user.role, "SUPER_ADMIN")

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Breadcrumbs className="mb-4" items={[{ label: "Compliance", href: "/compliance" }, { label: "Screening" }]} />
      <div>
        <h1 className="text-2xl font-semibold text-[var(--cf-text)]">PEP &amp; sanctions screening</h1>
        <p className="mt-1 text-sm text-[var(--cf-text-muted)]">
          {config.provider
            ? `Provider: ${config.provider}. Matches are decided by ${config.reviewMinRole === "ADMIN" ? "an admin" : "a branch manager"} or above${config.requireStaffTotp ? ", signed in with 2FA" : ""}, never by whoever started the run. A confirmed sanctions match cannot be cleared, and it or a rejected match blocks the party until a super admin lifts it.`
            : "Screening is not configured for this lender: no client is screened and approval is not gated on it."}
        </p>
      </div>
      <ScreeningReviewQueue
        items={queue.map((q) => ({ ...q, createdAt: q.createdAt.toISOString() }))}
        canReview={hasMinRole(user.role, config.reviewMinRole)}
        viewerId={user.id}
      />
      <ScreeningBlocksPanel blocks={blocks.map((b) => ({ ...b, createdAt: b.createdAt.toISOString() }))} canLift={superAdmin} />
      {superAdmin && (
        <ScreeningSettingsForm
          providers={providers}
          initial={{ provider: config.provider, reviewMinRole: config.reviewMinRole }}
        />
      )}
    </div>
  )
}
