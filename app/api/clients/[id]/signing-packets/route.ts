import { NextResponse } from "next/server"
import { lacksLoanBook } from "@/lib/security/loan-book-scope"
import type { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { getDocumentCaller } from "@/lib/document-auth"
import { auditDocumentAccessRefusal } from "@/lib/audit-refusals"
import { withTenantContextLoggingRefusal } from "@/lib/documents/tenant-refusal"
import {
  signingPacketLifecycle,
  type ReturnedPacketBinding,
} from "@/lib/documents/signing-packet-lifecycle"

interface RouteParams {
  params: Promise<{ id: string }>
}

/** The stamp POST /api/applications/[id]/signing-packet writes on a returned packet. */
function returnedPacketBinding(
  documentId: string,
  signatureState: string | null,
  validationResult: Prisma.JsonValue | null,
): ReturnedPacketBinding {
  const stamp =
    validationResult
    && typeof validationResult === "object"
    && !Array.isArray(validationResult)
      ? validationResult as Record<string, unknown>
      : null
  const digest = (key: string) => {
    const value = stamp?.[key]
    return typeof value === "string" ? value : null
  }
  return {
    id: documentId,
    boundAgreementSha256: digest("agreementDocumentSha256"),
    boundPasqSha256: digest("pasqDocumentSha256"),
    signatureState,
  }
}

/**
 * The signing-packet lifecycle for every application this client holds that has
 * reached agreement preparation.
 *
 * A list, not a single record: the open-application unique index is per
 * PRODUCT, so one client can legitimately hold two applications far enough
 * along to each have a packet. A findFirst here would silently show one
 * consumer's packet state for another application's loan.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id: clientId } = await params
    const caller = await getDocumentCaller()
    if (!caller) {
      await auditDocumentAccessRefusal({
        documentId: `client:${clientId}:signing-packets`,
        reason: "caller_not_resolvable_in_tenant",
        status: 401,
      })
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (caller.type === "client" && caller.clientId !== clientId) {
      await auditDocumentAccessRefusal({
        documentId: `client:${clientId}:signing-packets`,
        reason: "not_the_owning_client",
        status: 403,
        actorEmail: caller.email,
        detail: { accessorType: caller.type },
      })
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // The packets are the client's loan agreements: none for a role without the loan book.
    if (caller.type === "staff" && lacksLoanBook(caller.role)) return NextResponse.json([])

    return withTenantContextLoggingRefusal(req, { documentId: `client:${clientId}:signing-packets`, caller }, async (tenant) => {
      const applications = await prisma.loanApplication.findMany({
        where: {
          tenantId: tenant.id,
          clientId,
          agreementGeneratedAt: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          reference: true,
          agreementGeneratedAt: true,
          agreementDocumentSha256: true,
          pasqDocumentSha256: true,
          agreementSignedAt: true,
          agreementCountersignedAt: true,
          agreementExecutedDocumentId: true,
          signedPacketDocumentId: true,
        },
      })
      if (applications.length === 0) return NextResponse.json([])

      // Read the returned packets through their OWN rows rather than trusting
      // the application's pointer alone: a soft-deleted or re-typed document
      // must drop out of the card, not be offered as a dead link. Scoped to
      // this client so a mis-stamped binding can never surface another's packet.
      const packetIds = applications
        .map((a) => a.signedPacketDocumentId)
        .filter((v): v is string => v !== null)
      const packets = packetIds.length > 0
        ? await prisma.clientDocument.findMany({
            where: {
              id: { in: packetIds },
              tenantId: tenant.id,
              clientId,
              docType: "SIGNED_AGREEMENT_PACKET",
              deletedAt: null,
            },
            select: {
              id: true,
              signatureState: true,
              validationResult: true,
            },
          })
        : []
      const packetById = new Map(packets.map((p) => [p.id, p]))

      return NextResponse.json(applications.map((application) => {
        const packet = application.signedPacketDocumentId
          ? packetById.get(application.signedPacketDocumentId) ?? null
          : null
        return signingPacketLifecycle({
          applicationId: application.id,
          reference: application.reference,
          agreementGeneratedAt: application.agreementGeneratedAt,
          agreementDocumentSha256: application.agreementDocumentSha256,
          pasqDocumentSha256: application.pasqDocumentSha256,
          agreementSignedAt: application.agreementSignedAt,
          agreementCountersignedAt: application.agreementCountersignedAt,
          agreementExecutedDocumentId: application.agreementExecutedDocumentId,
          returnedPacket: packet
            ? returnedPacketBinding(
                packet.id,
                packet.signatureState,
                packet.validationResult,
              )
            : null,
        })
      }))
    })
  } catch (error) {
    console.error("List signing packets failed:", error)
    return NextResponse.json(
      { error: "Failed to list signing packets" },
      { status: 500 },
    )
  }
}
