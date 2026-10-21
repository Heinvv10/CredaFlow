import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { MAX_GUIDE_BYTES } from "@/lib/valuation-guides/csv"
import { parseGuideUploadFields } from "@/lib/valuation-guides/guide-input"
import { createDraftGuide } from "@/lib/valuation-guides/guide-store"
import { guideView } from "@/lib/valuation-guides/guide-view"
import { getValuationProvider } from "@/lib/valuation-guides/registry"
import { ValuationProviderError } from "@/lib/valuation-guides/types"

/** The lender's valuation guides, newest upload first (every status). */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const rows = await prisma.valuationGuide.findMany({ where: { tenantId: tenant.id }, orderBy: [{ uploadedAt: "desc" }, { id: "asc" }], take: 200 })
    return NextResponse.json({ guides: rows.map(guideView) })
  })
}

/**
 * Loads a valuation guide as a DRAFT (docs/asset-finance/SLICE5.md part C).
 * Multipart: `name`, `effectiveOn` (YYYY-MM-DD), `provider` (default `csv`)
 * and, for csv, `file` (at most 5 MB). A malformed file is 422 with a reason
 * per line and nothing stored (audited, counts only); the same file while a
 * draft or a published guide carries it is 409. Needs manage_valuation_guides;
 * a second person publishes it (./[id]/publish).
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_valuation_guides")) {
      return NextResponse.json({ error: "Loading a valuation guide needs the manage_valuation_guides permission" }, { status: 403 })
    }
    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: "Send the guide as multipart form data" }, { status: 400 })
    const fields = parseGuideUploadFields(form)
    if ("errors" in fields) return NextResponse.json({ error: "Invalid guide", fields: fields.errors }, { status: 400 })
    const provider = getValuationProvider(fields.data.provider)
    if (!provider) return NextResponse.json({ error: "Invalid guide", fields: { provider: "is not a valuation provider" } }, { status: 400 })
    const file = form.get("file")
    if (file instanceof File && file.size > MAX_GUIDE_BYTES) {
      return NextResponse.json({ error: "The guide was refused", problems: [{ line: 1, reason: "The file is larger than 5 MB" }], total: 1 }, { status: 422 })
    }
    const bytes = file instanceof File && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : undefined

    try {
      const result = await createDraftGuide({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, { ...fields.data, provider, bytes })
      switch (result.kind) {
        case "refused":
          return NextResponse.json({ error: "The guide was refused", problems: result.problems, total: result.total }, { status: 422 })
        case "duplicate_file":
          return NextResponse.json({ error: "This file is already loaded as a draft or published guide", guideId: result.existingId }, { status: 409 })
        case "created":
          return NextResponse.json(guideView(result.guide), { status: 201 })
      }
    } catch (error) {
      if (error instanceof ValuationProviderError) return NextResponse.json({ error: error.message }, { status: 422 })
      throw error
    }
  })
}
