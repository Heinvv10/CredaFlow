import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseLegalStepRequest } from "@/lib/asset-finance/legal-matter-input"
import { recordLegalStep } from "@/lib/asset-finance/legal-matter-step"

/** Record a step: JSON, or multipart with a `file` as evidence. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) return NextResponse.json({ error: "Recording a legal step needs manage_asset_finance" }, { status: 403 })
    const parsed = await parseLegalStepRequest(req, sastCalendarDate(new Date()))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid legal step", fields: parsed.errors }, { status: 400 })
    const { id } = await params
    const result = await recordLegalStep({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, parsed.data)
    if (result.kind === "not_found") return NextResponse.json({ error: "Legal matter not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result, { status: 201 })
  })
}
