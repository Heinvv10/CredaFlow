import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import {
  clientKycAuditValue,
  latestSelfieOrder,
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { assessBiometricEvidence } from "@/lib/kyc/biometric-evidence"
import { biometricFailureCopy } from "@/lib/kyc/biometric-failure-copy"
import { isLockedStatutoryEvidence } from "@/lib/documents/generic-action-policy"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  // KYC verification rolls a client to kycStatus VERIFIED, which is the gate
  // that unblocks origination at /decide. Keep it an origination credit-risk
  // action (CREDIT_OFFICER+), consistent with the manual KYC override PATCH on
  // /api/clients/[id]; collections/insurance/readonly roles should not complete
  // origination KYC.
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  const { id: clientId, docId } = await params

  let parsedBody: unknown
  try {
    parsedBody = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const rawBody = parsedBody as Record<string, unknown>
  if (typeof rawBody.verified !== "boolean") {
    return NextResponse.json(
      { error: "verified must be a boolean" },
      { status: 400 },
    )
  }
  if (rawBody.note !== undefined && typeof rawBody.note !== "string") {
    return NextResponse.json({ error: "note must be a string" }, { status: 400 })
  }
  if (rawBody.rejectReason !== undefined && typeof rawBody.rejectReason !== "string") {
    return NextResponse.json(
      { error: "rejectReason must be a string" },
      { status: 400 },
    )
  }

  const verificationNote =
    (rawBody.note as string | undefined)?.trim()
    || (rawBody.rejectReason as string | undefined)?.trim()
    || null
  if (!rawBody.verified && !verificationNote) {
    return NextResponse.json(
      { error: "A rejection reason is required when verification is rejected" },
      { status: 400 },
    )
  }

  const verified = rawBody.verified

  return withTenantContext(req, async (tenant) => {
    try {
      const mutation = await prisma.$transaction(async (tx) => {
        // Verification/unverification changes evidence used by payout. Hold the
        // same client-scoped lock as disbursement and update the document plus
        // rolled-up KYC state atomically.
        await lockAffordabilityClientEvidence(tx, {
          tenantId: tenant.id,
          clientId,
        })

        const clientCheck = await tx.client.findUnique({
          where: { id: clientId, tenantId: tenant.id },
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
        if (!clientCheck) return { error: "client" as const }

        const doc = await tx.clientDocument.findFirst({
          where: { id: docId, tenantId: tenant.id },
        })
        if (!doc || doc.clientId !== clientId || doc.deletedAt !== null) {
          return { error: "document" as const }
        }
        if (isLockedStatutoryEvidence(doc.docType)) {
          if (
            doc.docType === "CREDIT_AGREEMENT"
            || doc.docType === "EXECUTED_CREDIT_AGREEMENT"
          ) {
            return { error: "immutable_agreement" as const }
          }
          if (doc.docType === "DEBIT_MANDATE") {
            return { error: "immutable_debit_mandate" as const }
          }
          if (doc.docType === "SIGNED_AGREEMENT_PACKET") {
            return { error: "immutable_signed_packet" as const }
          }
          return { error: "immutable_form_20" as const }
        }
        if (doc.docType === "SELFIE") {
          const latestSelfie = await tx.clientDocument.findFirst({
            where: {
              tenantId: tenant.id,
              clientId,
              docType: "SELFIE",
            },
            orderBy: latestSelfieOrder(),
            select: { id: true },
          })
          if (latestSelfie?.id !== doc.id) {
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.BIOMETRIC_VERIFICATION_BLOCKED,
                entity: "ClientDocument",
                entityId: docId,
                oldValue: {
                  document: {
                    verified: doc.verified,
                    verifiedAt: doc.verifiedAt?.toISOString() ?? null,
                    verifiedById: doc.verifiedById,
                    verificationNote: doc.verificationNote,
                  },
                  clientKyc: clientKycAuditValue(clientCheck),
                },
                newValue: {
                  attemptedVerified: verified,
                  blocked: true,
                  reason: "superseded_biometric_evidence",
                  latestSelfieId: latestSelfie?.id ?? null,
                },
              },
            })
            return {
              error: "invalid_biometric_evidence" as const,
              reason: "superseded_biometric_evidence" as const,
            }
          }

          if (verified) {
            const biometricEvidence = assessBiometricEvidence(doc, {
              subject: clientCheck,
              requireDocumentVerified: false,
            })
            if (!biometricEvidence.ok) {
              await tx.auditLog.create({
                data: {
                  tenantId: tenant.id,
                  userId: guard.user.id,
                  userEmail: guard.user.email,
                  action: AuditAction.BIOMETRIC_VERIFICATION_BLOCKED,
                  entity: "ClientDocument",
                  entityId: docId,
                  oldValue: {
                    document: {
                      verified: doc.verified,
                      verifiedAt: doc.verifiedAt?.toISOString() ?? null,
                      verifiedById: doc.verifiedById,
                      verificationNote: doc.verificationNote,
                    },
                    clientKyc: clientKycAuditValue(clientCheck),
                  },
                  newValue: {
                    attemptedVerified: true,
                    blocked: true,
                    reason: biometricEvidence.reason,
                  },
                },
              })
              return {
                error: "invalid_biometric_evidence" as const,
                reason: biometricEvidence.reason,
              }
            }
          }
        }

        const verificationTime = new Date()
        const update = await tx.clientDocument.updateMany({
          where: { id: docId, tenantId: tenant.id, clientId, deletedAt: null },
          data: {
            verified,
            verifiedAt: verified ? verificationTime : null,
            verifiedById: verified ? guard.user.id : null,
            verificationNote,
            // A refusal has an author; record it. Without this the row is
            // byte-identical to the SYSTEM re-flagging a statement after a
            // bank-detail change, and the two cannot be told apart later.
            // Accepting clears it: the document is no longer refused.
            verificationRejectedAt: verified ? null : verificationTime,
            verificationRejectedById: verified ? null : guard.user.id,
          },
        })
        if (update.count !== 1) return { error: "document" as const }

        const updatedDoc = await tx.clientDocument.findFirst({
          where: { id: docId, tenantId: tenant.id },
        })

        const compositeKyc = await readCompositeKycState(
          tx as unknown as CompositeKycReader,
          {
            tenantId: tenant.id,
            clientId,
            subject: clientCheck,
            existing: clientCheck,
            completion: {
              verifiedAt: verificationTime,
              verifiedById: guard.user.id,
              method: doc.docType === "SELFIE" ? "BIOMETRIC" : "PHYSICAL",
            },
          },
        )
        const updatedClient = await tx.client.update({
          where: { id: clientId, tenantId: tenant.id },
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

        // Verification and its KYC roll-up are compliance state changes. Keep
        // the audit row in this transaction so an audit insertion failure
        // rolls the document and client changes back instead of committing an
        // unaudited verification decision.
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: verified ? AuditAction.DOCUMENT_VERIFIED : AuditAction.KYC_REJECTED,
            entity: "ClientDocument",
            entityId: docId,
            oldValue: {
              document: {
                verified: doc.verified,
                verifiedAt: doc.verifiedAt?.toISOString() ?? null,
                verifiedById: doc.verifiedById,
                verificationNote: doc.verificationNote,
              },
              clientKyc: clientKycAuditValue(clientCheck),
            },
            newValue: {
              document: {
                verified,
                note: verificationNote,
              },
              clientKyc: clientKycAuditValue(updatedClient),
            },
          },
        })

        return { error: null, doc, updatedDoc, kycStatus: updatedClient.kycStatus }
      })

      if (mutation.error === "client") {
        return NextResponse.json({ error: "Client not found" }, { status: 404 })
      }
      if (mutation.error === "document") {
        return NextResponse.json({ error: "Document not found" }, { status: 404 })
      }
      if (mutation.error === "immutable_agreement") {
        return NextResponse.json(
          { error: "Credit-agreement records are immutable and cannot be verified through the generic document workflow" },
          { status: 409 },
        )
      }
      if (mutation.error === "immutable_debit_mandate") {
        return NextResponse.json(
          { error: "Signed debit-mandate records are immutable and cannot be verified through the generic document workflow" },
          { status: 409 },
        )
      }
      if (mutation.error === "immutable_signed_packet") {
        return NextResponse.json(
          { error: "A returned signed packet is verified by recording the signature against its digest, not through the generic document workflow. Use Record Signed Packet on the application." },
          { status: 409 },
        )
      }
      if (mutation.error === "immutable_form_20") {
        return NextResponse.json(
          { error: "Form 20/PASQ is locked statutory evidence; complete it through the signing and acknowledgement workflow" },
          { status: 409 },
        )
      }
      if (mutation.error === "invalid_biometric_evidence") {
        // One sentence used to cover all seventeen refusal reasons: "stored
        // biometric evidence did not establish exactly one live, usable,
        // matching face." For most of them that is false. A selfie refused
        // because the client's details were edited afterwards HAS established
        // exactly one live, usable, matching face — it scored 90% match and 95%
        // liveness — and staff were told the opposite, which reads as a failed
        // or fraudulent capture rather than a record change they made.
        //
        // BIOMETRIC_FAILURE_COPY already carries true wording for every reason
        // in the union; this endpoint simply was not using it. The lookup
        // returns null for anything unrecognised, so a new reason degrades to a
        // claim that stays true rather than to a specific false one.
        const copy = biometricFailureCopy(mutation.reason)
        return NextResponse.json(
          {
            error: copy
              ? `${copy.label}. ${copy.detail}`
              : "This selfie's identity check cannot be accepted as evidence.",
            biometricEvidence: mutation.reason,
          },
          { status: 422 },
        )
      }

      return NextResponse.json({ document: mutation.updatedDoc, kycStatus: mutation.kycStatus })
    } catch (err) {
      console.error("[verify-doc] verification failed:", err)
      return NextResponse.json({ error: "Failed to update document" }, { status: 500 })
    }
  })
}
