import { NextResponse } from "next/server"
import { auditDocumentAccessRefusal } from "@/lib/audit-refusals"
import { prisma } from "@/lib/prisma"
import { deleteFile } from "@/lib/storage"
import { getDocumentCaller } from "@/lib/document-auth"
import { recordedCallerIp } from "@/lib/rate-limit"
import { withTenantContextLoggingRefusal } from "@/lib/documents/tenant-refusal"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { AuditAction } from "@/lib/audit"
import {
  clientKycAuditValue,
  isCoreKycDocumentType,
  latestSelfieOrder,
  readCompositeKycState,
  type ClientKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"

interface RouteParams {
  params: Promise<{ id: string }>
}

function sanitiseDoc(doc: Record<string, unknown>) {
  const { storagePath: _sp, ...safe } = doc
  return safe
}

export async function GET(req: Request, { params }: RouteParams) {
  const { id } = await params
  const caller = await getDocumentCaller()
  if (!caller) {
    await auditDocumentAccessRefusal({ documentId: id, reason: "caller_not_resolvable_in_tenant", status: 401, req })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return withTenantContextLoggingRefusal(req, { documentId: id, caller }, async (tenant) => {
    try {
      const doc = await prisma.clientDocument.findFirst({
        where: { id, tenantId: tenant.id },
      })

      if (!doc || doc.deletedAt) {
        return NextResponse.json({ error: "Document not found" }, { status: 404 })
      }

      // Portal users can only see their own docs
      if (caller.type === "client" && doc.clientId !== caller.clientId) {
        await auditDocumentAccessRefusal({ documentId: id, reason: "not_the_owning_client", status: 403, req })
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }

      // Log access (POPIA audit). This response returns the document metadata
      // INCLUDING extractionResult (VLM-extracted ID/name/DOB), so reading it
      // is a PII access that must be logged — same obligation the sibling /view
      // route already meets. `action: "metadata"` distinguishes it from a
      // file view/download.
      await prisma.documentAccessLog.create({
        data: {
          documentId: doc.id,
          accessorType: caller.type,
          accessorId: caller.type === "staff" ? caller.userId : caller.clientId,
          action: "metadata",
          ipAddress: recordedCallerIp(req),
          userAgent: req.headers.get("user-agent") ?? null,
        },
      })

      return NextResponse.json(sanitiseDoc(doc as unknown as Record<string, unknown>))
    } catch (error) {
      console.error("Document fetch failed:", error)
      return NextResponse.json(
        { error: "Failed to fetch document" },
        { status: 500 }
      )
    }
  })
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const { id } = await params
  const caller = await getDocumentCaller()
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Deleting a client document destroys evidence, and for the credit agreement
  // it is UNRECOVERABLE: POST /agreement refuses to regenerate once signed, and
  // there is no un-delete endpoint — the only road back is return-to-review,
  // which re-papers the loan and makes the consumer sign again. The DB now
  // refuses outright for a bound agreement (guardBoundAgreementDocument), a
  // bound PASQ and a bound debit mandate; this narrows WHO can reach the
  // destructive path at all for every other document.
  //
  // Checked before the document is read so a refusal has no side effects, not
  // even a DocumentAccessLog row. The client path is untouched — a portal user
  // is not staff and is already barred from deleting anything verified.
  if (caller.type === "staff" && caller.role !== "SUPER_ADMIN") {
    return NextResponse.json(
      { error: "Only a super admin may delete a client document." },
      { status: 403 },
    )
  }

  return withTenantContextLoggingRefusal(req, { documentId: id, caller }, async (tenant) => {
    try {
      const doc = await prisma.clientDocument.findFirst({
        where: { id, tenantId: tenant.id },
        include: { client: { select: { id: true } } },
      })

      if (!doc || doc.deletedAt) {
        return NextResponse.json({ error: "Document not found" }, { status: 404 })
      }

      // Access check
      if (caller.type === "client") {
        if (doc.clientId !== caller.clientId) {
          await auditDocumentAccessRefusal({ documentId: id, reason: "not_the_owning_client", status: 403, req })
          return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }
        // Portal users cannot delete verified documents
        if (doc.verified) {
          return NextResponse.json(
            { error: "Verified documents cannot be deleted" },
            { status: 403 }
          )
        }
      }
      // Staff: tenantId check would require client->tenant relation; skip for now as clients are global

      const deletion = await prisma.$transaction(async (tx) => {
        // Coordinate with disbursement before changing either the database row
        // or the backing file. Re-read after obtaining the lock so an earlier
        // mutation cannot be hidden by the optimistic check above.
        await lockAffordabilityClientEvidence(tx, {
          tenantId: tenant.id,
          clientId: doc.clientId,
        })
        const current = await tx.clientDocument.findFirst({
          where: { id, tenantId: tenant.id },
        })
        if (!current || current.deletedAt) return { status: 404 as const, doc: null }
        if (
          current.docType === "CREDIT_AGREEMENT"
          // The executed artifact carries both signatures — the only document
          // that evidences the consumer signed at all.
          || current.docType === "EXECUTED_CREDIT_AGREEMENT"
        ) {
          return { status: 409 as const, doc: null, immutable: "agreement" as const }
        }
        if (current.docType === "FORM_20_PRE_AGREEMENT") {
          return { status: 409 as const, doc: null, immutable: "pasq" as const }
        }
        if (current.docType === "DEBIT_MANDATE") {
          return { status: 409 as const, doc: null, immutable: "debit_mandate" as const }
        }
        // The PDF the consumer physically signed. This chain enumerates types
        // explicitly rather than calling isLockedStatutoryEvidence, so a type
        // added to that set stays DELETABLE here until it is named — which is
        // exactly the hole that left returned packets erasable as OTHER.
        if (current.docType === "SIGNED_AGREEMENT_PACKET") {
          return { status: 409 as const, doc: null, immutable: "signed_packet" as const }
        }
        if (caller.type === "client" && current.clientId !== caller.clientId) {
          return { status: 403 as const, doc: null }
        }
        if (caller.type === "client" && current.verified) {
          return { status: 403 as const, doc: null, verified: true }
        }

        const clientBefore = await tx.client.findUnique({
          where: { id: current.clientId, tenantId: tenant.id },
          select: {
            id: true,
            idNumber: true,
            firstName: true,
            lastName: true,
            dateOfBirth: true,
            kycStatus: true,
            kycVerifiedAt: true,
            kycVerifiedById: true,
            kycVerificationMethod: true,
            kycManualRejectionActive: true,
            kycManualRejectionAt: true,
            kycManualRejectionById: true,
            kycManualRejectionReason: true,
            kycManualRejectionResolvedAt: true,
            kycManualRejectionResolvedById: true,
            kycManualRejectionResolutionReason: true,
          },
        })
        if (!clientBefore) return { status: 404 as const, doc: null }

        // A deleted biometric attempt remains part of the ordered KYC history.
        // Otherwise deleting the newest failed/unverified attempt would make an
        // older passing selfie look current again.
        const latestSelfie = current.docType === "SELFIE"
          ? await tx.clientDocument.findFirst({
              where: {
                tenantId: tenant.id,
                clientId: current.clientId,
                docType: "SELFIE",
              },
              orderBy: latestSelfieOrder(),
              select: { id: true },
            })
          : null
        const deletingLatestSelfie = latestSelfie?.id === current.id

        const deletedAt = new Date()
        const updated = await tx.clientDocument.updateMany({
          where: { id, tenantId: tenant.id, deletedAt: null },
          data: {
            deletedAt,
            deletedByType: caller.type,
            deletedById:
              caller.type === "staff" ? caller.userId : caller.clientId,
          },
        })
        if (updated.count !== 1) return { status: 404 as const, doc: null }

        let clientAfter: ClientKycState = clientBefore
        if (deletingLatestSelfie || isCoreKycDocumentType(current.docType)) {
          const compositeKyc = await readCompositeKycState(
            tx as unknown as CompositeKycReader,
            {
              tenantId: tenant.id,
              clientId: current.clientId,
              subject: clientBefore,
              existing: clientBefore,
              preserveVerifiedProvenance: true,
            },
          )
          // A client's delete may only LOWER the stored status. Deleting a
          // pending replacement ID would otherwise re-derive VERIFIED on the
          // older copy and promote the client with no verifier on record;
          // restoring VERIFIED is a staff verification's job.
          const clientPromotion =
            caller.type === "client" &&
            compositeKyc.state.kycStatus === "VERIFIED" &&
            clientBefore.kycStatus !== "VERIFIED"
          if (!clientPromotion) {
            clientAfter = await tx.client.update({
              where: { id: current.clientId, tenantId: tenant.id },
              data: compositeKyc.state,
              select: {
                kycStatus: true,
                kycVerifiedAt: true,
                kycVerifiedById: true,
                kycVerificationMethod: true,
                kycManualRejectionActive: true,
                kycManualRejectionAt: true,
                kycManualRejectionById: true,
                kycManualRejectionReason: true,
                kycManualRejectionResolvedAt: true,
                kycManualRejectionResolvedById: true,
                kycManualRejectionResolutionReason: true,
              },
            })
          }
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: caller.type === "staff" ? caller.userId : null,
            userEmail: caller.type === "client" ? caller.email : null,
            action: AuditAction.DOCUMENT_DELETED,
            entity: "ClientDocument",
            entityId: current.id,
            oldValue: {
              document: {
                docType: current.docType,
                verified: current.verified,
                verifiedAt: current.verifiedAt?.toISOString() ?? null,
                verifiedById: current.verifiedById,
                verificationNote: current.verificationNote,
                deletedAt: null,
              },
              clientKyc: clientKycAuditValue(clientBefore),
            },
            newValue: {
              document: {
                docType: current.docType,
                verified: current.verified,
                deletedAt: deletedAt.toISOString(),
                deletedByType: caller.type,
                deletedById: caller.type === "staff" ? caller.userId : caller.clientId,
                ...(current.docType === "SELFIE" && {
                  latestBiometricAttempt: deletingLatestSelfie,
                }),
              },
              clientKyc: clientKycAuditValue(clientAfter),
            },
          },
        })

        return { status: 200 as const, doc: current }
      })

      if (deletion.status === 404) {
        return NextResponse.json({ error: "Document not found" }, { status: 404 })
      }
      if (deletion.status === 403) {
        return NextResponse.json(
          { error: "verified" in deletion ? "Verified documents cannot be deleted" : "Forbidden" },
          { status: 403 },
        )
      }
      if (deletion.status === 409) {
        return NextResponse.json(
          {
            error: deletion.immutable === "debit_mandate"
              ? "Signed debit-mandate records are immutable and cannot be deleted"
              : deletion.immutable === "signed_packet"
                ? "A returned signed packet is the only artifact carrying the consumer's signature and cannot be deleted"
                : "Credit-agreement and statutory PASQ records are immutable and cannot be deleted",
          },
          { status: 409 },
        )
      }

      // Delete the physical file only after the soft-delete commits. A payout
      // beginning now observes deletedAt and fails closed; deleting first used
      // to let the file disappear while payout still saw a valid DB row.
      if (deletion.doc.storagePath) {
        await deleteFile(deletion.doc.storagePath)
      }

      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error("Document delete failed:", error)
      return NextResponse.json(
        { error: "Failed to delete document" },
        { status: 500 }
      )
    }
  })
}
