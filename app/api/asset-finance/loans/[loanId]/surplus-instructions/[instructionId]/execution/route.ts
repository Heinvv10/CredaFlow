import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseSurplusExecutionForm, recordSurplusExecution } from "@/lib/asset-finance/nca-surplus-execution"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
type Context = { params: Promise<{ loanId: string; instructionId: string }> }
export async function POST(req: NextRequest, { params }: Context) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "record_payment")) return NextResponse.json({ error: "Bank execution requires payment staff" }, { status: 403 })
    const input = await parseSurplusExecutionForm(req)
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 })
    const { loanId, instructionId } = await params
    const result = await recordSurplusExecution({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, loanId, instructionId, input)
    if (result.kind === "not_found") return NextResponse.json({ error: "Instruction not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
export async function GET(req: NextRequest, { params }: Context) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "record_payment")) return NextResponse.json({ error: "Bank evidence requires payment staff" }, { status: 403 })
    const { loanId, instructionId } = await params
    const row = await prisma.ncaSurplusRemittance.findFirst({ where: { id: instructionId, tenantId: tenant.id, OR: [{ surrender: { loanId } }, { recovery: { loanId } }] }, select: { executionEvidenceDocument: true } })
    if (!row?.executionEvidenceDocument || row.executionEvidenceDocument.deletedAt) return NextResponse.json({ error: "Execution evidence not found" }, { status: 404 })
    return serveEntityDocument(req, row.executionEvidenceDocument, { type: "staff", id: guard.user.id })
  })
}
