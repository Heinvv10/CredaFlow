import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { recordAssetFinanceAffordability } from "@/lib/asset-finance/affordability-store"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "decide_asset_finance")) {
      return NextResponse.json({ error: "Recording the s81 assessment needs decide_asset_finance" }, { status: 403 })
    }
    const body = await req.json().catch(() => null) as { recklessLendingNote?: unknown } | null
    const note = typeof body?.recklessLendingNote === "string" ? body.recklessLendingNote : ""
    const { id } = await params
    const result = await prisma.$transaction((tx) => recordAssetFinanceAffordability(
      tx,
      { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email },
      id,
      note,
    ))
    switch (result.kind) {
      case "not_found": return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_editable": return NextResponse.json({ error: `The assessment is fixed once the deal is ${result.status}` }, { status: 409 })
      case "financials_required": return NextResponse.json({ error: "Record the credit memo and schedule first" }, { status: 422 })
      case "personal_ndi_required": return NextResponse.json({ error: "Complete the sole proprietor's consumer affordability assessment first" }, { status: 422 })
      case "note_required": return NextResponse.json({ error: "A reckless-lending note of at least 10 characters is required" }, { status: 400 })
      case "recorded": return NextResponse.json(result)
    }
  })
}
