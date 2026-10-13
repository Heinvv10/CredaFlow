import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import {
  dealBureauSubjects, recentlyCheckedClientIds, RECHECK_WINDOW_DAYS, runDealBureauCheck, type DealBureauOutcome,
} from "@/lib/asset-finance/deal-bureau"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"

const OPEN_FOR_CHECKS = ["DRAFT", "SUBMITTED", "REFERRED"]

/**
 * Run the existing consumer bureau check (Experian) for every active
 * DIRECTOR and TRUSTEE of the deal's entity (manage_asset_finance; goal
 * decision 2a.3). One check per person, sequentially; each attempt is stored
 * against the deal's application (lib/asset-finance/deal-bureau.ts) and the
 * run is audited with every person's outcome. 422 when the entity has no
 * director or trustee; 409 once the deal is decided.
 *
 * A person with a check stored for this application in the last
 * RECHECK_WINDOW_DAYS is not enquired on again (outcome "recent"): every
 * enquiry marks their credit record. Body `{ force: true }` re-checks them;
 * it needs decide_asset_finance (403, audited) and the run is audited as
 * ASSET_DEAL_BUREAU_FORCED_RERUN with the people re-checked. Concurrent runs
 * make one enquiry per person: runDealBureauCheck re-checks under a lock, and
 * a forced run skips a person a concurrent run has just checked.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Running bureau checks needs the manage_asset_finance permission" }, { status: 403 })
    }
    const { id } = await params
    const body: unknown = await req.json().catch(() => null)
    const force = typeof body === "object" && body !== null && (body as { force?: unknown }).force === true
    if (force && !canDo(guard.user.role, "decide_asset_finance")) {
      await auditRefusal({
        action: AuditAction.ASSET_DEAL_BUREAU_FORCE_REFUSED,
        entity: "AssetFinanceDeal",
        entityId: id,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason: "insufficient_role",
        status: 403,
      })
      return NextResponse.json({ error: "Re-running a bureau check inside 30 days needs the decide_asset_finance permission" }, { status: 403 })
    }
    const deal = await prisma.assetFinanceDeal.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true, status: true, entityId: true, applicationId: true },
    })
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 })
    if (!OPEN_FOR_CHECKS.includes(deal.status)) {
      return NextResponse.json({ error: `Bureau checks are closed once a deal is ${deal.status}` }, { status: 409 })
    }
    const subjects = await dealBureauSubjects(tenant.id, deal.entityId)
    if (subjects.length === 0) {
      return NextResponse.json({ error: "The entity has no active director or trustee to check" }, { status: 422 })
    }

    const startedAt = new Date()
    const recent = await recentlyCheckedClientIds(tenant.id, deal.applicationId, subjects.map((s) => s.clientId), startedAt)
    const results: Array<{ clientId: string; role: string; outcome: DealBureauOutcome }> = []
    const auditRun = (interruptedAtClientId?: string) => {
      const rechecked = force
        ? results.map((result) => result.clientId).filter((clientId) => recent.has(clientId))
        : []
      return logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: force ? AuditAction.ASSET_DEAL_BUREAU_FORCED_RERUN : AuditAction.ASSET_DEAL_BUREAU_CHECKED,
        entity: "AssetFinanceDeal",
        entityId: deal.id,
        newValue: {
          applicationId: deal.applicationId, provider: "experian", results,
          ...(interruptedAtClientId ? { interrupted: true, interruptedAtClientId } : {}),
          ...(force ? { forced: true, recheckedWithinDays: RECHECK_WINDOW_DAYS, recheckedClientIds: [...new Set(rechecked)] } : {}),
        },
      })
    }
    for (const subject of subjects) {
      try {
        const outcome = recent.has(subject.clientId) && !force
          ? "recent" as const
          : await runDealBureauCheck(tenant.id, deal.applicationId, subject, { force, startedAt })
        results.push({ clientId: subject.clientId, role: subject.role, outcome })
      } catch (error) {
        await auditRun(subject.clientId)
        throw error
      }
    }
    await auditRun()
    return NextResponse.json({ results, deal: await loadDealDetail(tenant.id, deal.id) })
  })
}
