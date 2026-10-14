import type { Prisma } from "@prisma/client"
import { AuditAction } from "@/lib/audit"
import {
  clientKycAuditValue,
  readCompositeKycState,
  type ClientKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"

const clientKycSelect = {
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
} satisfies Prisma.ClientSelect

/** The slice of a transaction client this projection touches. */
export type IdUploadProjectionTransaction = {
  client: {
    findUnique: (args: {
      where: Prisma.ClientWhereUniqueInput
      select: typeof clientKycSelect
    }) => Promise<Prisma.ClientGetPayload<{ select: typeof clientKycSelect }> | null>
    update: (args: {
      where: Prisma.ClientWhereUniqueInput
      data: ClientKycState
      select: typeof clientKycSelect
    }) => Promise<Prisma.ClientGetPayload<{ select: typeof clientKycSelect }>>
  }
  auditLog: {
    create: (args: { data: Prisma.AuditLogUncheckedCreateInput }) => Promise<unknown>
  }
} & CompositeKycReader

function sameKycProjection(a: ClientKycState, b: ClientKycState): boolean {
  return a.kycStatus === b.kycStatus &&
    a.kycVerifiedAt?.getTime() === b.kycVerifiedAt?.getTime() &&
    a.kycVerifiedById === b.kycVerifiedById &&
    a.kycVerificationMethod === b.kycVerificationMethod
}

/**
 * Re-derive the stored Client KYC projection after an ID_COPY upload and
 * write it back, with an audit row, when it no longer matches the evidence.
 *
 * Callers must hold the client evidence lock and run inside the same
 * transaction as the upload, so a concurrent verification cannot interleave.
 *
 * Downgrade only. An upload is not a verification: if the evidence still
 * derives VERIFIED while the stored status is not, the stored status is left
 * for a verification path (or the database guard) to promote.
 */
export async function reprojectKycAfterIdUpload(
  tx: IdUploadProjectionTransaction,
  args: {
    tenantId: string
    clientId: string
    documentId: string
    actor:
      | { type: "staff"; userId: string; email?: string | null }
      | { type: "client"; email: string }
  },
): Promise<{ changed: boolean }> {
  const before = await tx.client.findUnique({
    where: { id: args.clientId, tenantId: args.tenantId },
    select: clientKycSelect,
  })
  if (!before) return { changed: false }

  const composite = await readCompositeKycState(tx, {
    tenantId: args.tenantId,
    clientId: args.clientId,
    subject: before,
    existing: before,
    preserveVerifiedProvenance: true,
  })
  if (composite.state.kycStatus === "VERIFIED" && before.kycStatus !== "VERIFIED") {
    return { changed: false }
  }
  if (sameKycProjection(before, composite.state)) return { changed: false }

  const after = await tx.client.update({
    where: { id: args.clientId, tenantId: args.tenantId },
    data: composite.state,
    select: clientKycSelect,
  })

  await tx.auditLog.create({
    data: {
      tenantId: args.tenantId,
      userId: args.actor.type === "staff" ? args.actor.userId : null,
      userEmail: args.actor.email ?? null,
      action: AuditAction.KYC_STATUS_CHANGED,
      entity: "Client",
      entityId: args.clientId,
      oldValue: { clientKyc: clientKycAuditValue(before) },
      newValue: {
        clientKyc: clientKycAuditValue(after),
        reason: "id_document_uploaded",
        documentId: args.documentId,
        missingCoreDocuments: composite.missingCoreDocuments,
        coreDocumentGaps: composite.coreDocumentGaps.map((gap) => ({
          docType: gap.docType,
          state: gap.state,
        })),
      },
    },
  })
  return { changed: true }
}
