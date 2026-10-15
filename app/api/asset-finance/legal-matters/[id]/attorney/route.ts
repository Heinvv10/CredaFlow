import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseAppointAttorney } from "@/lib/asset-finance/legal-matter-input"
import { appointAttorney } from "@/lib/asset-finance/legal-matter-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) return NextResponse.json({ error: "Appointing an attorney needs manage_asset_finance" }, { status: 403 })
    const parsed = parseAppointAttorney(await req.json().catch(() => null), sastCalendarDate(new Date()))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid appointment", fields: parsed.errors }, { status: 400 })
    const { id } = await params
    const result = await appointAttorney({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, parsed.data)
    if (result.kind === "not_found") return NextResponse.json({ error: "Legal matter not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
