import { NextRequest, NextResponse } from "next/server"
import { withSigningStaff } from "@/lib/asset-finance/signing-route"
import { parseEntityDocumentForm } from "@/lib/asset-finance/entity-document-io"
import { SIGNED_DOC_TYPE } from "@/lib/asset-finance/signing"
import { uploadWetInkScan } from "@/lib/asset-finance/signing-wet-ink"
import { loadStaffSigningPanel } from "@/lib/asset-finance/signing-view"

/**
 * Record the scan of a document signed in wet ink for one signer
 * (manage_asset_finance). Multipart: `file` and `docType` — the SIGNED_* type
 * of the signer's document. Replaces an unconfirmed scan; a second user then
 * confirms it (…/confirm).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; signerId: string }> }) {
  const { id, signerId } = await params
  return withSigningStaff(req, { dealId: id, manage: true }, async ({ tenantId, user }) => {
    const parsed = await parseEntityDocumentForm(req, Object.values(SIGNED_DOC_TYPE), { allowDeal: false })
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const result = await uploadWetInkScan({ tenantId, userId: user.id, userEmail: user.email }, id, signerId, parsed.upload)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Signer not found" }, { status: 404 })
      case "wrong_type":
        return NextResponse.json({ error: `This signer's scan is a ${result.expected}` }, { status: 400 })
      case "not_open":
        return NextResponse.json({ error: result.reason }, { status: 409 })
      case "done":
        return NextResponse.json(await loadStaffSigningPanel(tenantId, id), { status: 201 })
    }
  })
}
