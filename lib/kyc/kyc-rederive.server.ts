import type { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import {
  clientKycAuditValue,
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { manualPendingStands } from "@/lib/kyc/manual-pending.server"
import { newestVerifiedIdCopyId, verificationRestorable } from "@/lib/kyc/verification-restorable"

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

/** The slice of the app's transaction client this action uses. */
export type KycRederiveTransaction = Pick<typeof prisma, "client" | "clientDocument" | "auditLog" | "$queryRaw">

export type KycRederiveResult =
  | { kind: "client_not_found" }
  | { kind: "document_not_found" }
  /** The named ID copy is no longer verified, current, unrefused and on file. */
  | { kind: "id_document_not_current" }
  /** The evidence no longer derives VERIFIED, or the stored status is not PENDING. */
  | { kind: "evidence_does_not_hold" }
  /** A staff member's deliberate manual PENDING is the latest status change. */
  | { kind: "manual_pending_stands" }
  | { kind: "rederived"; kycStatus: string }

/**
 * "Re-verify ID": re-derive a PENDING client's stored KYC status from the
 * evidence already on file. It verifies and attests nothing: the ID copy's
 * verifiedAt/verifiedById stay as they are, and the VERIFIED provenance is the
 * evidence's own (the passed selfie, or the attestation's officer), never the
 * acting officer's and never a PHYSICAL stamp of this action.
 *
 * Under the client evidence lock it refuses unless the ID copy staff were
 * shown is still the newest verified, non-deleted, unrefused copy (a refusal or
 * newer verification in another tab makes the click stale), and unless the
 * evidence derives VERIFIED while the stored status is PENDING and no
 * deliberate manual PENDING stands (verificationRestorable), so the API cannot
 * undo a decision the hidden button would not offer.
 * Client_enforce_composite_kyc re-checks the write.
 * One KYC_STATUS_REDERIVED audit row, in the same transaction.
 */
export async function rederiveKycStatus(
  tx: KycRederiveTransaction,
  args: { tenantId: string; clientId: string; idDocumentId: string; actor: { id: string; email: string | null } },
): Promise<KycRederiveResult> {
  const { tenantId, clientId } = args
  await lockAffordabilityClientEvidence(tx, { tenantId, clientId })

  const client = await tx.client.findUnique({ where: { id: clientId, tenantId }, select: clientKycSelect })
  if (!client) return { kind: "client_not_found" }
  const target = await tx.clientDocument.findFirst({
    where: { id: args.idDocumentId, tenantId, clientId, docType: "ID_COPY" },
    select: { id: true, verified: true, deletedAt: true, verificationRejectedAt: true, verificationRejectedById: true },
  })
  if (!target) return { kind: "document_not_found" }

  const verifiedCopies = await tx.clientDocument.findMany({
    where: { tenantId, clientId, docType: "ID_COPY", deletedAt: null, verified: true },
    select: { id: true, docType: true, verified: true, createdAt: true },
  })
  const current = target.verified &&
    target.deletedAt === null &&
    target.verificationRejectedAt === null &&
    target.verificationRejectedById === null &&
    newestVerifiedIdCopyId(verifiedCopies) === target.id
  if (!current) return { kind: "id_document_not_current" }

  const composite = await readCompositeKycState(tx as unknown as CompositeKycReader, {
    tenantId,
    clientId,
    subject: client,
    existing: client,
    preserveVerifiedProvenance: true,
  })
  const manualPending = await manualPendingStands(tx, { tenantId, clientId })
  if (!verificationRestorable(client.kycStatus, composite, { manualPendingStands: manualPending })) {
    return { kind: manualPending ? "manual_pending_stands" : "evidence_does_not_hold" }
  }

  const after = await tx.client.update({
    where: { id: clientId, tenantId },
    data: composite.state,
    select: clientKycSelect,
  })
  await logAuditStrict({
    tenantId,
    userId: args.actor.id,
    userEmail: args.actor.email ?? undefined,
    action: AuditAction.KYC_STATUS_REDERIVED,
    entity: "Client",
    entityId: clientId,
    oldValue: { clientKyc: clientKycAuditValue(client) },
    newValue: {
      clientKyc: clientKycAuditValue(after),
      reason: "evidence_rederived",
      idDocumentId: target.id,
    },
  }, tx)
  return { kind: "rederived", kycStatus: after.kycStatus }
}
