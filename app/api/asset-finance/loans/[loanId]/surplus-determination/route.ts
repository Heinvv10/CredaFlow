import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseEntityDocumentForm } from "@/lib/asset-finance/entity-document-io"
import { recordSurplusDetermination } from "@/lib/asset-finance/nca-surplus-determination"
export async function POST(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async tenant => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "decide_asset_finance")) return NextResponse.json({ error: "Decision permission required" }, { status: 403 })
    const parsed = await parseEntityDocumentForm(req.clone(), ["OTHER"], { allowDeal: false })
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const form = await req.formData(), determination = form.get("competingAgreement")
    if (determination !== "YES" && determination !== "NO") return NextResponse.json({ error: "Unknown is not a determination of no competing agreement" }, { status: 400 })
    const { loanId } = await params
    const result = await recordSurplusDetermination({ tenantId: tenant.id, userId: guard.user.id }, loanId, { competingAgreement: determination === "YES", basis: String(form.get("basis") ?? ""), upload: parsed.upload })
    if (result.kind === "not_found") return NextResponse.json({ error: "NCA loan not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
export async function GET(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async tenant => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) return NextResponse.json({ error: "Staff asset finance permission required" }, { status: 403 })
    const { loanId } = await params
    const row = await prisma.ncaSurplusDetermination.findFirst({ where: { tenantId: tenant.id, loanId }, include: { evidenceDocument: true } })
    if (!row) return NextResponse.json({ error: "Determination evidence not found" }, { status: 404 })
    if (row.evidenceDocument.deletedAt) return NextResponse.json({ error: "Determination evidence unavailable" }, { status: 404 })
    return serveEntityDocument(req, row.evidenceDocument, { type: "staff", id: guard.user.id })
  })
}
