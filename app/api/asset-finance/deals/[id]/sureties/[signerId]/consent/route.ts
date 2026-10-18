import { NextRequest, NextResponse } from "next/server"
import { withPayoutStaff } from "@/lib/asset-finance/payout-route"
import { parseSuretyConsent, recordSuretyConsent } from "@/lib/asset-finance/surety-consent"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; signerId: string }> }) {
  const { id, signerId } = await params
  return withPayoutStaff(req, { dealId: id, permission: "manage_asset_finance" }, async ({ tenantId, user, refuse }) => {
    const input = parseSuretyConsent(await req.json().catch(() => null))
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 })
    const result = await recordSuretyConsent({ tenantId, userId: user.id, userEmail: user.email }, id, signerId, input)
    if ("error" in result) return refuse("surety_consent", result.status!, result.error!)
    return NextResponse.json(result)
  })
}
