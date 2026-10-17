import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { logDocumentAccess } from "@/lib/document-auth"
import { formatDatePdf, formatZarPdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter } from "@/lib/asset-finance/documents/pdf-layout"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { legalWordingApproved } from "@/lib/asset-finance/documents/nca/legal-wording-approved"
export async function GET(req: NextRequest, { params }: { params: Promise<{ loanId: string; instructionId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async tenant => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) return NextResponse.json({ error: "Staff asset-finance permission required" }, { status: 403 })
    const { loanId, instructionId } = await params
    const row = await prisma.ncaSurplusRemittance.findFirst({ where: { id: instructionId, tenantId: tenant.id, executedOn: { not: null }, OR: [{ surrender: { loanId, finalNoticePath: { not: null } } }, { recovery: { loanId, finalNoticePath: { not: null } } }] }, include: { account: true } })
    if (!row?.executedOn || !row.account) return NextResponse.json({ error: "Issued account statement and actual remittance evidence required" }, { status: 404 })
    await logDocumentAccess(prisma, { documentId: row.id, accessorType: "staff", accessorId: guard.user.id, action: "download", req })
    const writer = await DealDocumentWriter.create({ title: `Surplus remittance confirmation ${row.id}`, documentDate: row.executionRecordedAt! })
    writer.title("SUPPLEMENTAL SURPLUS REMITTANCE CONFIRMATION", [])
    writer.labelValues([["Instruction", row.id], ["Amount remitted", formatZarPdf(row.amountCents)], ["Executed on", formatDatePdf(row.executedOn)], ["Recipient", row.account.recipient === "TRIBUNAL" ? "National Consumer Tribunal" : "Consumer"], ["Bank reference", row.bankExecutionReference!]])
    writer.paragraph(row.exceptionReason ? `The original account statement recorded this exception: ${row.exceptionReason}. That statement is retained unchanged. The surplus payable was outstanding until the actual remittance evidenced above.` : "Actual surplus remittance is evidenced above. The original final account notice is retained unchanged.")
    writer.paragraph(row.account.recipient === "TRIBUNAL" ? "The credit provider has provided the post-sale account statement and remitted the surplus to the National Consumer Tribunal under section 127(6)(a), for distribution as it directs. This confirmation does not assert consumer-remittance termination under section 127(6)(b). It records an external bank payment and does not initiate a transfer." : "The credit provider has provided the post-sale account statement and remitted the surplus under section 127(6). The agreement has terminated under section 127(6)(b), subject to any correction ordered by the National Consumer Tribunal. This confirmation records an external bank payment; it does not initiate a transfer.")
    const bytes = await writer.finish({ reference: row.id, watermark: !await legalWordingApproved(prisma, tenant.id) })
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } })
  })
}
