import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { dealBureauSubjects, runDealBureauCheck, type DealBureauOutcome } from "@/lib/asset-finance/deal-bureau"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"

const OPEN_FOR_CHECKS = ["DRAFT", "SUBMITTED", "REFERRED"]

/**
 * Run the existing consumer bureau check (Experian) for every active
 * DIRECTOR and TRUSTEE of the deal's entity (manage_asset_finance; goal
 * decision 2a.3). One check per person, sequentially; each attempt is stored
 * against the deal's application (lib/asset-finance/deal-bureau.ts) and the
 * run is audited with every person's outcome. 422 when the entity has no
 * director or trustee; 409 once the deal is decided.
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

    const results: Array<{ clientId: string; role: string; outcome: DealBureauOutcome }> = []
    for (const subject of subjects) {
      results.push({ clientId: subject.clientId, role: subject.role, outcome: await runDealBureauCheck(tenant.id, deal.applicationId, subject) })
    }
    await logAuditStrict({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: AuditAction.ASSET_DEAL_BUREAU_CHECKED,
      entity: "AssetFinanceDeal",
      entityId: deal.id,
      newValue: { applicationId: deal.applicationId, provider: "experian", results },
    })
    return NextResponse.json({ results, deal: await loadDealDetail(tenant.id, deal.id) })
  })
}
