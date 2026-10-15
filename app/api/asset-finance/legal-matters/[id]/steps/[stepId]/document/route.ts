import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { findStepEvidence } from "@/lib/asset-finance/legal-matter-view"

/** A step's evidence file; the read is logged (DocumentAccessLog) before the bytes are served. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, stepId } = await params
    const document = await findStepEvidence(tenant.id, id, stepId)
    if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    return serveEntityDocument(req, document, { type: "staff", id: guard.user.id })
  })
}
