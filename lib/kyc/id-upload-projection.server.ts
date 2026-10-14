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

type ClientKycRow = Prisma.ClientGetPayload<{ select: typeof clientKycSelect }>

/** The slice of a transaction client this projection touches. */
export type IdUploadProjectionTransaction = {
  client: {
    findUnique: (args: {
      where: Prisma.ClientWhereUniqueInput
      select: typeof clientKycSelect
    }) => Promise<ClientKycRow | null>
    update: (args: {
      where: Prisma.ClientWhereUniqueInput
      data: ClientKycState
      select: typeof clientKycSelect
    }) => Promise<ClientKycRow>
  }
  auditLog: {
    create: (args: { data: Prisma.AuditLogUncheckedCreateInput }) => Promise<unknown>
  }
} & CompositeKycReader

export type IdUploadActor =
  | { type: "staff"; userId: string; email?: string | null }
  | { type: "client"; email: string }

/**
 * The client's stored KYC row as it stands BEFORE the ID copy is inserted.
 * The insert itself can demote a VERIFIED client (the database's revoke
 * trigger), so the audit row has to compare against this snapshot, not
 * against whatever the re-derivation finds afterwards.
 */
export async function readKycBeforeIdUpload(
  tx: IdUploadProjectionTransaction,
  args: { tenantId: string; clientId: string },
): Promise<ClientKycRow | null> {
  return tx.client.findUnique({
    where: { id: args.clientId, tenantId: args.tenantId },
    select: clientKycSelect,
  })
}

function sameKycProjection(a: ClientKycState, b: ClientKycState): boolean {
  return a.kycStatus === b.kycStatus &&
    a.kycVerifiedAt?.getTime() === b.kycVerifiedAt?.getTime() &&
    a.kycVerifiedById === b.kycVerifiedById &&
    a.kycVerificationMethod === b.kycVerificationMethod
}

/**
 * After an ID_COPY upload: re-derive the stored Client KYC projection, write
 * it back when it no longer matches the evidence, and record ONE
 * actor-attributed audit row whenever the upload left the stored status
 * different from `before` (the snapshot taken ahead of the insert), whether
 * the database's trigger or this re-derivation moved it.
 *
 * Callers must hold the client evidence lock and run inside the same
 * transaction as the upload, so a concurrent verification cannot interleave.
 *
 * Never promotes. An upload is not a verification: if the evidence derives
 * VERIFIED while the stored status is not, the stored status is left for a
 * verification path to promote. Any other change is written, including
 * FAILED -> PENDING when the only blocker was a refused ID that this upload
 * has now replaced. A stored and derived VERIFIED pair is not rewritten, so
 * the verifier's provenance stays untouched.
 */
export async function reprojectKycAfterIdUpload(
  tx: IdUploadProjectionTransaction,
  args: {
    tenantId: string
    clientId: string
    documentId: string
    before: ClientKycRow | null
    actor: IdUploadActor
  },
): Promise<{ changed: boolean }> {
  const { before } = args
  if (!before) return { changed: false }
  const current = await readKycBeforeIdUpload(tx, args)
  if (!current) return { changed: false }

  const composite = await readCompositeKycState(tx, {
    tenantId: args.tenantId,
    clientId: args.clientId,
    subject: current,
    existing: current,
    preserveVerifiedProvenance: true,
  })
  const rewrite = composite.state.kycStatus !== "VERIFIED" &&
    !sameKycProjection(current, composite.state)
  const after = rewrite
    ? await tx.client.update({
        where: { id: args.clientId, tenantId: args.tenantId },
        data: composite.state,
        select: clientKycSelect,
      })
    : current
  if (after.kycStatus === before.kycStatus) return { changed: false }

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
        // True when the ClientDocument insert's database trigger had already
        // moved the status before the re-derivation ran.
        demotedByDatabase: current.kycStatus !== before.kycStatus,
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
