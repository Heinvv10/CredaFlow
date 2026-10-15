import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { rederiveKycStatus } from "@/lib/kyc/kyc-rederive.server"

/**
 * POST { idDocumentId }: re-derive the client's stored KYC status from the
 * evidence on file ("Re-verify ID" on the staff KYC tab). Same gate as the
 * document verify route it replaces for this purpose: CREDIT_OFFICER+, with
 * the session's 2FA policy enforced by requireApiRole. It writes no document.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  const { id: clientId } = await params
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const idDocumentId = (body as { idDocumentId?: unknown } | null)?.idDocumentId
  if (typeof idDocumentId !== "string" || idDocumentId === "") {
    return NextResponse.json({ error: "idDocumentId must be a document id" }, { status: 400 })
  }

  return withTenantContext(req, async (tenant) => {
    try {
      const result = await prisma.$transaction((tx) => rederiveKycStatus(tx, {
        tenantId: tenant.id,
        clientId,
        idDocumentId,
        actor: { id: guard.user.id, email: guard.user.email ?? null },
      }))
      switch (result.kind) {
        case "client_not_found":
          return NextResponse.json({ error: "Client not found" }, { status: 404 })
        case "document_not_found":
          return NextResponse.json({ error: "ID document not found" }, { status: 404 })
        case "id_document_not_current":
          return NextResponse.json({
            error: "This ID copy is no longer the client's current verified copy. Reload the page to see its state.",
            reason: result.kind,
          }, { status: 409 })
        case "evidence_does_not_hold":
          return NextResponse.json({
            error: "The evidence on file no longer supports VERIFIED. Reload the page to see what is outstanding.",
            reason: result.kind,
          }, { status: 409 })
        case "rederived":
          return NextResponse.json({ kycStatus: result.kycStatus })
      }
    } catch (err) {
      console.error("[kyc-rederive] re-derivation failed:", err)
      return NextResponse.json({ error: "Failed to re-derive KYC status" }, { status: 500 })
    }
  })
}
