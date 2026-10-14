import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { creditSurrenderProceeds } from "@/lib/asset-finance/surrender-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "record_payment")) return NextResponse.json({ error: "Crediting sale proceeds needs record_payment" }, { status: 403 })
    const body = await req.json().catch(() => null) as { saleProceedsCents?: unknown; receivedAt?: unknown } | null
    const receivedAt = typeof body?.receivedAt === "string" ? new Date(body.receivedAt) : undefined
    if (typeof body?.saleProceedsCents !== "number" || (receivedAt && !Number.isFinite(receivedAt.getTime()))) return NextResponse.json({ error: "Provide valid saleProceedsCents and receivedAt" }, { status: 400 })
    const { id } = await params
    const result = await creditSurrenderProceeds({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, body.saleProceedsCents, receivedAt)
    if (result.kind === "not_found") return NextResponse.json({ error: "Surrender not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
