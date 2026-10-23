import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { decisionRecordsForClient } from "@/lib/learning-loop/dsar-export"

// Every decision record about the request's client (POPIA access), as a JSON
// download. The audit row is the access event; it is written before the body
// leaves, so an export that cannot be recorded is not served.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const dsar = await prisma.dataSubjectRequest.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true, reference: true, clientId: true },
    })
    if (!dsar) return NextResponse.json({ error: "DSAR not found" }, { status: 404 })

    const records = await decisionRecordsForClient(prisma, tenant.id, dsar.clientId)

    await logAuditStrict({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: AuditAction.DSAR_DECISION_RECORDS_EXPORTED,
      entity: "DataSubjectRequest",
      entityId: dsar.id,
      newValue: { clientId: dsar.clientId, recordCount: records.length, format: "json" },
    })

    const filename = `decision-records-${dsar.reference.replace(/[^A-Za-z0-9_-]/g, "_")}.json`
    const body = { dsarReference: dsar.reference, clientId: dsar.clientId, exportedAt: new Date(), recordCount: records.length, records }
    return new NextResponse(JSON.stringify(body, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  })
}
