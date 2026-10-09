import { NextResponse } from "next/server"
import { auditRefusal, auditDocumentAccessRefusal } from "@/lib/audit-refusals"
import { AuditAction } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { getDocumentCaller } from "@/lib/document-auth"
import { withTenantContext } from "@/lib/tenant"
import {
  documentBytesMatchSha256,
  isSha256Digest,
} from "@/lib/documents/content-integrity"

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(req: Request, { params }: RouteParams) {
  const { id } = await params
  const caller = await getDocumentCaller()
  if (!caller) {
    // A cross-tenant client reaches HERE, not the 403 below: it is
    // authenticated but resolves to no Client row in this tenant, so
    // getDocumentCaller returns null. That is 10 of the 11 refusals the
    // E2E-04 walkthrough recorded, and none of them was logged.
    await auditDocumentAccessRefusal({
      documentId: id,
      reason: "caller_not_resolvable_in_tenant",
      status: 401,
      req,
    })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Set when the inner ownership check already wrote a row, so the wrapper
  // seam below does not double-log the same 403.
  let loggedOwnershipRefusal = false
  // A tenant-B staff user probing a tenant-A document is refused by
  // withTenantContext BEFORE the callback runs, so neither the 401 hook above
  // nor the ownership check inside ever sees it. Inspect the wrapper's own
  // response so a cross-tenant staff probe leaves a row too.
  const outcome = await withTenantContext(req, async (tenant) => {
    try {
      const doc = await prisma.clientDocument.findFirst({ where: { id, tenantId: tenant.id } })
      if (!doc || doc.deletedAt || !doc.storagePath) {
        return NextResponse.json({ error: "Document not found" }, { status: 404 })
      }

      // Access check.
      //
      // A REFUSAL is recorded, not just a grant. Every DocumentAccessLog writer
      // in this route sits after the checks, so eleven denied accesses in the
      // E2E-04 walkthrough produced zero rows in the POPIA access register and
      // zero audit rows. The control held — nothing leaked — but someone
      // enumerating document ids across a tenant boundary left no trace, so it
      // could not surface in a DSAR or a regulator export.
      if (caller.type === "client" && doc.clientId !== caller.clientId) {
        await auditRefusal({
          action: AuditAction.DOCUMENT_ACCESS_REFUSED,
          entity: "ClientDocument",
          entityId: id,
          tenantId: tenant.id,
          userEmail: caller.email ?? undefined,
          reason: "not_the_owning_client",
          status: 403,
          detail: { accessorType: caller.type, documentClientId: doc.clientId },
        })
        loggedOwnershipRefusal = true
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }

      const isCreditAgreement = doc.docType === "CREDIT_AGREEMENT"
      // The EXECUTED artifact gets the SAME integrity and binding treatment as
      // the unsigned document it derives from. It carries both signatures, so
      // serving it unchecked would leave the only proof the consumer signed as
      // the least verified document in the set.
      const isExecutedAgreement = doc.docType === "EXECUTED_CREDIT_AGREEMENT"
      const isDebitMandate = doc.docType === "DEBIT_MANDATE"
      if (isExecutedAgreement) {
        if (!isSha256Digest(doc.contentSha256)) {
          return NextResponse.json(
            {
              error: "The signed credit agreement is missing its document integrity binding and cannot be viewed.",
              agreementIntegrity: "binding_missing",
            },
            { status: 422 },
          )
        }
        const executedBinding = await prisma.loanApplication.findFirst({
          where: {
            tenantId: tenant.id,
            clientId: doc.clientId,
            agreementExecutedDocumentId: doc.id,
            agreementExecutedDocumentSha256: doc.contentSha256,
          },
          select: { id: true },
        })
        if (!executedBinding) {
          return NextResponse.json(
            {
              error: "The signed credit agreement is not bound to an application.",
              agreementIntegrity: "application_binding_mismatch",
            },
            { status: 422 },
          )
        }
      }
      if (isCreditAgreement) {
        if (!isSha256Digest(doc.contentSha256)) {
          return NextResponse.json(
            {
              error: "The credit agreement is missing its document integrity binding and cannot be viewed.",
              agreementIntegrity: "binding_missing",
            },
            { status: 422 },
          )
        }
        const applicationBinding = await prisma.loanApplication.findFirst({
          where: {
            tenantId: tenant.id,
            clientId: doc.clientId,
            agreementDocumentId: doc.id,
            agreementDocumentSha256: doc.contentSha256,
          },
          select: { id: true },
        })
        // A generation binding must belong to an application of THIS client.
        //
        // `entityId` was unconstrained, so any audit row naming this document
        // authenticated it — for any application, of any client, in this
        // tenant. Paired with a backfill that could write a SECOND binding to
        // an already-bound application, that let one loan carry two documents
        // both serving as the authentic credit agreement. Scoping the lookup to
        // the client's own applications is the reader-side half of that fix
        // (the writer-side half lived in a since-removed one-off backfill).
        const clientApplicationIds = applicationBinding
          ? []
          : (
              await prisma.loanApplication.findMany({
                where: { tenantId: tenant.id, clientId: doc.clientId },
                select: { id: true },
              })
            ).map((a) => a.id)
        const generationBinding =
          applicationBinding || clientApplicationIds.length === 0
            ? null
            : await prisma.auditLog.findFirst({
                where: {
                  tenantId: tenant.id,
                  action: {
                    in: ["AGREEMENT_GENERATED", "AGREEMENT_INTEGRITY_BACKFILLED"],
                  },
                  entity: "LoanApplication",
                  entityId: { in: clientApplicationIds },
                  AND: [
                    {
                      newValue: {
                        path: ["documentId"],
                        equals: doc.id,
                      },
                    },
                    {
                      newValue: {
                        path: ["documentSha256"],
                        equals: doc.contentSha256,
                      },
                    },
                  ],
                },
                select: { id: true },
              })
        if (!applicationBinding && !generationBinding) {
          return NextResponse.json(
            {
              error: "The credit agreement is not bound to an application or its immutable generation history.",
              agreementIntegrity: "application_binding_mismatch",
            },
            { status: 422 },
          )
        }
      }
      if (isDebitMandate) {
        if (!isSha256Digest(doc.contentSha256)) {
          return NextResponse.json(
            {
              error: "The signed debit mandate is missing its document integrity binding and cannot be viewed.",
              debitMandate: "binding_missing",
            },
            { status: 422 },
          )
        }
        const applicationBinding = await prisma.loanApplication.findFirst({
          where: {
            tenantId: tenant.id,
            clientId: doc.clientId,
            debitMandateDocumentId: doc.id,
            debitMandateDocumentSha256: doc.contentSha256,
            debitMandateSignedAt: doc.signedAt,
          },
          select: { id: true },
        })
        if (!applicationBinding) {
          return NextResponse.json(
            {
              error: "The signed debit mandate is not bound to its application evidence.",
              debitMandate: "application_binding_mismatch",
            },
            { status: 422 },
          )
        }
      }

      // Log access (POPIA audit)
      await prisma.documentAccessLog.create({
        data: {
          documentId: doc.id,
          accessorType: caller.type,
          accessorId:
            caller.type === "staff" ? caller.userId : caller.clientId,
          action: new URL(req.url).searchParams.get("download") === "1"
            ? "download"
            : "view",
          ipAddress: req.headers.get("x-forwarded-for") ?? null,
          userAgent: req.headers.get("user-agent") ?? null,
        },
      })

      let buffer: Buffer
      try {
        buffer = await readFile(doc.storagePath)
      } catch (error) {
        if (isCreditAgreement || isExecutedAgreement || isDebitMandate) {
          return NextResponse.json(
            {
              error: isDebitMandate
                ? "The bound debit-mandate bytes are unavailable."
                : "The bound credit-agreement bytes are unavailable.",
              ...(isDebitMandate
                ? { debitMandate: "bytes_missing" }
                : { agreementIntegrity: "bytes_missing" }),
            },
            { status: 422 },
          )
        }
        throw error
      }
      if (
        (isCreditAgreement || isExecutedAgreement || isDebitMandate) &&
        !documentBytesMatchSha256(buffer, doc.contentSha256)
      ) {
        return NextResponse.json(
          {
            error: isDebitMandate
              ? "The debit-mandate bytes failed their integrity check and cannot be viewed."
              : "The credit-agreement bytes failed their integrity check and cannot be viewed.",
            ...(isDebitMandate
              ? { debitMandate: "content_mismatch" }
              : { agreementIntegrity: "content_mismatch" }),
          },
          { status: 422 },
        )
      }
      const isDownload =
        new URL(req.url).searchParams.get("download") === "1"

      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": doc.mimeType || "application/octet-stream",
          "Content-Disposition": isDownload
            ? `attachment; filename="${doc.fileName}"`
            : `inline; filename="${doc.fileName}"`,
          "Content-Length": String(buffer.length),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      })
    } catch (error) {
      console.error("Document view failed:", error)
      return NextResponse.json(
        { error: "Failed to serve document" },
        { status: 500 }
      )
    }
  })

  // 4xx only, matching refusalReasonFrom: a 5xx is a crash, not a refusal, and
  // filing server failures here would pollute the trail.
  if (outcome instanceof Response && outcome.status >= 400 && outcome.status < 500) {
    const alreadyLogged = outcome.status === 403 && loggedOwnershipRefusal
    if (!alreadyLogged) {
      await auditDocumentAccessRefusal({
        documentId: id,
        reason: outcome.status === 403 ? "tenant_scope_refused" : `unlabelled_${outcome.status}`,
        status: outcome.status,
        actorEmail: caller.type === "client" ? caller.email : undefined,
        actorUserId: caller.type === "staff" ? caller.userId : undefined,
        req,
      })
    }
  }
  return outcome
}
