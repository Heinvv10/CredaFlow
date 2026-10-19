import { NextRequest, NextResponse } from "next/server"
import { supplierBankAccountView } from "@/lib/asset-finance/supplier-bank-view"
import { loadRunStatement } from "@/lib/dealer/staff-view"
import { withDealerStaff } from "@/lib/dealer/staff-route"

/** A payable run's statement: dealer, account, status trail and lines (manage_dealers). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withDealerStaff(req, "manage_dealers", async ({ tenantId, user }) => {
    const run = await loadRunStatement(tenantId, (await params).runId)
    if (!run) return NextResponse.json({ error: "Payable run not found" }, { status: 404 })
    return NextResponse.json({ ...run, bankAccount: supplierBankAccountView(run.bankAccount, user.role) })
  })
}
