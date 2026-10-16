import { NextResponse } from "next/server"
import { auditDocumentAccessRefusal } from "@/lib/audit-refusals"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDocumentCaller } from "@/lib/document-auth"
import { lacksLoanBook } from "@/lib/security/loan-book-scope"
import { withTenantContextLoggingRefusal } from "@/lib/documents/tenant-refusal"
import {
  PORTAL_KYC_SNAPSHOT_OPTIONS,
  readPortalKycDocumentState,
} from "@/lib/kyc/portal-document-state"

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id: clientId } = await params
    const caller = await getDocumentCaller()
    if (!caller) {
      // This route had NO DocumentAccessLog writer at all — neither for grants
      // nor refusals. A refused LIST is an enumeration attempt and is exactly
      // what a POPIA access register should be able to show.
      await auditDocumentAccessRefusal({
        documentId: `client:${clientId}`,
        reason: "caller_not_resolvable_in_tenant",
        status: 401,
      })
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Portal clients can only list their own docs
    if (caller.type === "client" && caller.clientId !== clientId) {
      await auditDocumentAccessRefusal({
        documentId: `client:${clientId}`,
        reason: "not_the_owning_client",
        status: 403,
        actorEmail: caller.email,
        detail: { accessorType: caller.type },
      })
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // The extraction is the lending read of a document (payslip income, bank
    // statement lines): a role without the loan book gets the files, not it.
    const withoutLoanBook = caller.type === "staff" && lacksLoanBook(caller.role)
    const shown = <T extends { storagePath: unknown; extractionResult?: unknown }>(doc: T) => {
      const { storagePath: _sp, ...rest } = doc
      if (!withoutLoanBook) return rest
      const { extractionResult: _er, ...visible } = rest
      return visible
    }

    return withTenantContextLoggingRefusal(req, { documentId: `client:${clientId}`, caller }, async (tenant) => {
      const includeKycChecklist =
        req.nextUrl.searchParams.get("includeKycChecklist") === "1"
      if (includeKycChecklist) {
        const client = await prisma.$transaction(
          (tx) => readPortalKycDocumentState(tx, {
            tenantId: tenant.id,
            clientWhere: { id: clientId },
          }),
          PORTAL_KYC_SNAPSHOT_OPTIONS,
        )
        if (!client) {
          return NextResponse.json({ error: "Client not found" }, { status: 404 })
        }

        const safe = client.documents.map(shown)
        return NextResponse.json({
          documents: safe,
          kycChecklist: client.kycChecklist,
        })
      }

      const docs = await prisma.clientDocument.findMany({
        where: { tenantId: tenant.id, clientId, deletedAt: null },
        orderBy: { createdAt: "desc" },
      })

      // Strip storagePath from response
      return NextResponse.json(docs.map(shown))
    })
  } catch (error) {
    console.error("List documents failed:", error)
    return NextResponse.json(
      { error: "Failed to list documents" },
      { status: 500 }
    )
  }
}
