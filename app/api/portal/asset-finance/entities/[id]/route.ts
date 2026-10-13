import { NextRequest, NextResponse } from "next/server"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { loadPortalEntityView } from "@/lib/asset-finance/portal-entities"

type Params = { params: Promise<{ id: string }> }

/** One entity's summary and its applications, deals and loans (read-only). */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withPortalEntity(req, id, async ({ tenantId }) => {
    const view = await loadPortalEntityView(tenantId, id)
    if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json(view)
  })
}
