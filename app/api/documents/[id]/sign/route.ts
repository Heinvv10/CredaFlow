import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDocumentCaller } from "@/lib/document-auth"
import { withTenantContextLoggingRefusal } from "@/lib/documents/tenant-refusal"
import { logAudit, AuditAction } from "@/lib/audit"

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * Signs a `ClientDocument` — the native e-signature counterpart to
 * `app/api/applications/[id]/agreement/sign/route.ts`, generalised to any
 * document (not just the credit agreement). That route is deliberately left
 * untouched; this one mirrors its ownership + IP-capture pattern instead.
 *
 * Reachable by both staff and CLIENT sessions: `isSharedClientApiPath` in
 * proxy.ts already allowlists `/api/documents/*` (except `/extract`) for the
 * portal host, so — exactly like the agreement route's `isClientSession`
 * guard — a CLIENT caller's ownership of the target document is enforced
 * unconditionally, not gated on `method`. Staff sign on behalf of the client.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const caller = await getDocumentCaller()
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  return withTenantContextLoggingRefusal(req, { documentId: id, caller }, async (tenant) => {
    const body = (await req.json()) as { method?: string }
    const method = body.method
    if (method !== "branch" && method !== "portal") {
      return NextResponse.json({ error: "method must be 'branch' or 'portal'" }, { status: 400 })
    }

    const doc = await prisma.clientDocument.findFirst({
      where: { id, tenantId: tenant.id },
    })
    if (!doc || doc.deletedAt) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 })
    }

    // A CLIENT session may only ever sign a document belonging to their OWN
    // client record — enforced unconditionally (NOT gated on `method`); see
    // the module doc comment above.
    if (caller.type === "client" && doc.clientId !== caller.clientId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Credit agreements carry application-level affordability, document-hash
    // and signature evidence. They must only be signed through the dedicated
    // route that verifies all three atomically.
    if (doc.docType === "CREDIT_AGREEMENT") {
      return NextResponse.json(
        {
          error: "Credit agreements must be signed through the application agreement workflow.",
          agreementIntegrity: "dedicated_signing_required",
        },
        { status: 409 },
      )
    }
    if (doc.docType === "DEBIT_MANDATE") {
      return NextResponse.json(
        {
          error: "Debit mandates must be signed through the application repayment-setup workflow.",
          debitMandate: "dedicated_signing_required",
        },
        { status: 409 },
      )
    }

    if (doc.signatureState === "signed") {
      return NextResponse.json({ error: "Document is already signed" }, { status: 409 })
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? req.headers.get("x-real-ip")
      ?? null

    const signedAt = new Date()

    const updated = await prisma.clientDocument.update({
      where: { id, tenantId: tenant.id },
      data: {
        signatureState: "signed",
        signedAt,
        signedByIp: ip,
      },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: caller.type === "staff" ? caller.userId : undefined,
      userEmail: caller.type === "client" ? caller.email : undefined,
      action: AuditAction.DOCUMENT_SIGNED,
      entity: "ClientDocument",
      entityId: id,
      newValue: { method, signedAt: signedAt.toISOString() },
      ipAddress: ip ?? undefined,
    })

    // POPIA access log (lib/document-auth.ts writes this pattern elsewhere).
    await prisma.documentAccessLog.create({
      data: {
        documentId: id,
        accessorType: caller.type,
        accessorId: caller.type === "staff" ? caller.userId : caller.clientId,
        action: "signed",
        ipAddress: ip,
      },
    })

    return NextResponse.json(updated)
  })
}
