import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { parseBankAccountDecision } from "@/lib/asset-finance/supplier-input"
import { supplierBankAccountView } from "@/lib/asset-finance/supplier-bank-view"
import { decideDealerBankAccount } from "@/lib/dealer/staff-bank-accounts"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Approve or reject a PENDING dealer bank account (decide_asset_finance).
 * Body `{ decision: "APPROVE" | "REJECT", note }`: on approval the note is the
 * verification evidence (AVS cannot run for a juristic account). The decider
 * is never the requester (403; also CHECK DealerBankAccount_four_eyes).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ accountId: string }> }) {
  return withDealerStaff(req, "decide_asset_finance", async ({ tenantId, user }) => {
    const parsed = parseBankAccountDecision(await jsonBody(req))
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 })
    const { accountId } = await params
    const result = await prisma.$transaction((tx) => decideDealerBankAccount(tx, {
      tenantId, accountId, decision: parsed.decision, note: parsed.note, decider: { id: user.id, email: user.email },
    }))
    if (result.kind === "refused") return refusalResponse(result)
    if (result.kind === "self_decision") {
      return NextResponse.json({ error: "A dealer bank account must be decided by someone other than its requester" }, { status: 403 })
    }
    return NextResponse.json(supplierBankAccountView(result.account, user.role))
  })
}
