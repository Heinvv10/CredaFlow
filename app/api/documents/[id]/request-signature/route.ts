import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { getSigner, type Signer } from "@/lib/documents/signing"
import { logAudit, AuditAction } from "@/lib/audit"
import { refuseReadOnlyDocumentWrite } from "@/lib/documents/write-access"

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * Staff-only entry point into the `lib/documents/signing` provider
 * abstraction (Task 15/16/17) — sends a generated `ClientDocument` for
 * signature. `signingMethod` is resolved from the document's own
 * `DocumentTemplate` (not a request-body field: the template, not the
 * caller, decides how a document is signed), and `signers` is derived from
 * the client's own name/email rather than trusted from the caller.
 *
 * A document with no `templateId` (staff-uploaded/OCR-captured, never
 * generated from a catalogue template) or whose template's `signingMethod`
 * is `NONE` is rejected the same way — there is nothing to request.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const readOnly = await refuseReadOnlyDocumentWrite({
      caller: { type: "staff", userId: guard.user.id, role: guard.user.role, tenantId: tenant.id },
      documentId: id,
      tenantId: tenant.id,
      action: "request_signature",
      req,
    })
    if (readOnly) return readOnly

    const doc = await prisma.clientDocument.findFirst({
      where: { id, tenantId: tenant.id },
    })
    if (!doc || doc.deletedAt) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 })
    }
    if (doc.docType === "CREDIT_AGREEMENT") {
      return NextResponse.json(
        {
          error: "Credit agreements must use the application agreement signing workflow.",
          agreementIntegrity: "dedicated_signing_required",
        },
        { status: 409 },
      )
    }
    if (doc.docType === "DEBIT_MANDATE") {
      return NextResponse.json(
        {
          error: "Debit mandates must use the customer repayment-setup workflow.",
          debitMandate: "dedicated_signing_required",
        },
        { status: 409 },
      )
    }

    const template = doc.templateId
      ? await prisma.documentTemplate.findFirst({
          where: { id: doc.templateId, tenantId: tenant.id },
        })
      : null

    const signingMethod = template?.signingMethod ?? "NONE"
    if (signingMethod === "NONE") {
      return NextResponse.json(
        { error: "Document does not require signature" },
        { status: 400 }
      )
    }

    const client = await prisma.client.findFirst({
      where: { id: doc.clientId, tenantId: tenant.id },
    })
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 })
    }

    const signers: Signer[] = [
      { name: `${client.firstName} ${client.lastName}`, email: client.email },
    ]

    let result
    try {
      result = await getSigner(signingMethod).requestSignature(tenant.id, id, signers)
    } catch (e) {
      // SIGNUM is a stub gated behind DOCUMENT_SIGNUM_ENABLED (Task 17 full
      // integration is future work) — always rejects. Map that to a stable
      // client-facing error instead of leaking the raw env-flag message.
      if (signingMethod === "SIGNUM") {
        return NextResponse.json({ error: "Signum not enabled" }, { status: 501 })
      }
      throw e
    }

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      action: AuditAction.DOCUMENT_SIGNATURE_REQUESTED,
      entity: "ClientDocument",
      entityId: id,
      newValue: { signingMethod, ref: result.ref, status: result.status },
    })

    return NextResponse.json(result)
  })
}
