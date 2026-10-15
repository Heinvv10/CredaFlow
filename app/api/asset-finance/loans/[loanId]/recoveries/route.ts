import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { parseCreateRecovery } from "@/lib/asset-finance/recovery-input"
import { invalidBody, recoveryResponse, withRecoveryStaff } from "@/lib/asset-finance/recovery-route"
import { createRecovery } from "@/lib/asset-finance/recovery-store"

type Params = { params: Promise<{ loanId: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  return withRecoveryStaff(req, null, async (actor) => {
    const { loanId } = await params
    if (await prisma.loan.count({ where: { id: loanId, tenantId: actor.tenantId } }) !== 1) return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    const rows = await prisma.recovery.findMany({
      where: { tenantId: actor.tenantId, loanId }, orderBy: { createdAt: "desc" }, select: { id: true, route: true, status: true, recoveredOn: true },
    })
    return NextResponse.json({ recoveries: rows.map((r) => ({ ...r, recoveredOn: r.recoveredOn.toISOString().slice(0, 10) })) })
  })
}

export async function POST(req: NextRequest, { params }: Params) {
  return withRecoveryStaff(req, "manage_asset_finance", async (actor) => {
    const parsed = parseCreateRecovery(await req.json().catch(() => null))
    if ("errors" in parsed) return invalidBody(parsed.errors)
    const { loanId } = await params
    return recoveryResponse(await createRecovery(actor, loanId, parsed.data), "Loan not found", true)
  })
}
