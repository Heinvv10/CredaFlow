import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { serveCreditNotePdf } from "@/lib/vat/credit-note-serve"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const response = await serveCreditNotePdf(prisma, req, { tenantId: tenant.id, id }, { type: "staff", id: guard.user.id })
    return response ?? NextResponse.json({ error: "Credit note not found" }, { status: 404 })
  })
}
