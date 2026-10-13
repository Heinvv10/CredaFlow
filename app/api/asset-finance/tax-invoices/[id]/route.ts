import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { serveTaxInvoicePdf } from "@/lib/vat/tax-invoice-serve"

/**
 * An issued tax invoice as a PDF (any staff role; `?download=1` as an
 * attachment). Rendered from the stored row alone; the read is logged in
 * DocumentAccessLog against the invoice id before the PDF is produced.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const response = await serveTaxInvoicePdf(prisma, req, { tenantId: tenant.id, invoiceId: id }, { type: "staff", id: guard.user.id })
    return response ?? NextResponse.json({ error: "Tax invoice not found" }, { status: 404 })
  })
}
