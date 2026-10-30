import { keyFactsRefusal } from "@/lib/non-nca-documents/refusal"
import { NextResponse, type NextRequest } from "next/server"
import { requireOwnerOrStaff } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { prisma } from "@/lib/prisma"
import { recordPasqAcknowledgement } from "@/lib/compliance/pasq-acknowledgement.server"
import { EntityBorrowerError, hasClientBorrowerId } from "@/lib/borrower"
import { recordedCallerIp } from "@/lib/rate-limit"

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * Portal acknowledgement of the PASQ, by the signed-in consumer.
 *
 * The evidence itself is written by `recordPasqAcknowledgement`, shared with
 * the one-time-link surface, so both channels record the same legal act
 * identically. Staff have no acknowledgement path here or anywhere else — see
 * that module for why.
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const keyFactsRefusedNew = await keyFactsRefusal(tenant.id, id)
    if (keyFactsRefusedNew) return keyFactsRefusedNew
    const body = await req.json().catch(() => null) as { documentSha256?: unknown } | null
    if (!isSha256Digest(body?.documentSha256)) {
      return NextResponse.json({
        error: "documentSha256 must identify the exact PASQ being acknowledged.",
      }, { status: 400 })
    }
    const documentSha256 = body.documentSha256
    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: { clientId: true },
    })
    if (!application) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    // The PASQ is a consumer document (NCA s.92); an entity borrower has none.
    if (!hasClientBorrowerId(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    const access = await requireOwnerOrStaff(application.clientId)
    if (access.error) return access.error
    if (access.type !== "client") {
      return NextResponse.json({
        error: "Only the client who owns the application may acknowledge the PASQ.",
      }, { status: 403 })
    }

    const result = await recordPasqAcknowledgement({
      tenantId: tenant.id,
      applicationId: id,
      documentSha256,
      clientId: access.clientId,
      clientEmail: access.clientEmail,
      method: "portal",
      ipAddress: recordedCallerIp(req),
      userAgent: req.headers.get("user-agent") ?? null,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({
      success: true,
      documentSha256,
      acknowledgedAt: result.acknowledgedAt,
      ...(result.existing ? { existing: true } : {}),
    })
  })
}
