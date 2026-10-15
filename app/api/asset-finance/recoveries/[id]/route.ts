import { NextRequest, NextResponse } from "next/server"
import { loadStaffRecoveryView } from "@/lib/asset-finance/recovery-view"
import { withRecoveryStaff } from "@/lib/asset-finance/recovery-route"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRecoveryStaff(req, null, async (actor) => {
    const { id } = await params
    const view = await loadStaffRecoveryView(actor.tenantId, id)
    return view ? NextResponse.json(view) : NextResponse.json({ error: "Recovery not found" }, { status: 404 })
  })
}
