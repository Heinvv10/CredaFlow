import { NextRequest, NextResponse } from "next/server"
import { parseBankAccountRequest } from "@/lib/asset-finance/supplier-input"
import { supplierBankAccountView } from "@/lib/asset-finance/supplier-bank-view"
import { requestDealerBankAccount } from "@/lib/dealer/staff-bank-accounts"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Requests a dealer bank account, a first one or a change (manage_dealers).
 * Staff capture only (a dealer never sends bank details). It is PENDING until
 * a different user with decide_asset_finance approves it at
 * /api/asset-finance/dealers/bank-accounts/[accountId]/decide.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withDealerStaff(req, "manage_dealers", async ({ staff, user }) => {
    const parsed = parseBankAccountRequest(await jsonBody(req))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid bank account", fields: parsed.errors }, { status: 400 })
    const result = await requestDealerBankAccount(staff, (await params).id, parsed.data)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json(supplierBankAccountView(result.account, user.role), { status: 201 })
  })
}
