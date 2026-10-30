import { NextResponse, type NextRequest } from "next/server"
import { requireOwnerOrStaff } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { acknowledgeKeyFacts } from "@/lib/non-nca-documents/acknowledge"

type RouteCtx = { params: Promise<{ id: string }> }

/** The borrower's acknowledgement of the key facts statement they were shown (its digest echoed). Staff have no path here. */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json().catch(() => null) as { documentSha256?: unknown } | null
    if (!isSha256Digest(body?.documentSha256)) {
      return NextResponse.json({ error: "documentSha256 must identify the exact key facts statement being acknowledged." }, { status: 400 })
    }
    const application = await prisma.loanApplication.findFirst({ where: { id, tenantId: tenant.id }, select: { clientId: true } })
    if (!application?.clientId) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    const access = await requireOwnerOrStaff(application.clientId)
    if (access.error) return access.error
    if (access.type !== "client") return NextResponse.json({ error: "Only the borrower may acknowledge the key facts statement." }, { status: 403 })
    const result = await acknowledgeKeyFacts({
      tenantId: tenant.id, applicationId: id, clientId: access.clientId, clientEmail: access.clientEmail, shown: body.documentSha256, ipAddress: recordedCallerIp(req) ?? undefined,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ success: true, acknowledgedAt: result.acknowledgedAt })
  })
}
