import { Prisma } from "@prisma/client"
import {
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { derivePortalKycChecklist } from "@/lib/kyc/portal-checklist"

const portalClientDocumentSelect = {
  id: true,
  tenantId: true,
  clientId: true,
  docType: true,
  fileUrl: true,
  fileName: true,
  storagePath: true,
  contentSha256: true,
  mimeType: true,
  fileSize: true,
  verified: true,
  uploadedByType: true,
  uploadedById: true,
  deletedAt: true,
  extractionStatus: true,
  extractionResult: true,
  extractionError: true,
  validationResult: true,
  validationMismatch: true,
  validationScore: true,
  biometricMatchScore: true,
  biometricLiveness: true,
  biometricVerifiedAt: true,
  biometricResult: true,
  verifiedAt: true,
  verifiedById: true,
  verificationNote: true,
  verificationRejectedById: true,
  verificationRejectedAt: true,
  createdAt: true,
} satisfies Prisma.ClientDocumentSelect

const portalClientKycSelect = {
  id: true,
  idNumber: true,
  firstName: true,
  lastName: true,
  dateOfBirth: true,
  popiaConsentGiven: true,
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
  documents: {
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" as const },
    select: portalClientDocumentSelect,
  },
} satisfies Prisma.ClientSelect

type PortalClientKycSnapshot = Prisma.ClientGetPayload<{
  select: typeof portalClientKycSelect
}>

interface PortalKycSnapshotReader extends CompositeKycReader {
  client: {
    findFirst: (args: {
      where: Prisma.ClientWhereInput
      select: typeof portalClientKycSelect
    }) => Promise<PortalClientKycSnapshot | null>
  }
}

export const PORTAL_KYC_SNAPSHOT_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
} as const

/**
 * Read every input used by the portal document list and derived KYC checklist
 * through one transaction client. Callers must supply a repeatable-read
 * transaction so a concurrent staff decision cannot mix row versions.
 */
export async function readPortalKycDocumentState(
  tx: PortalKycSnapshotReader,
  args: {
    tenantId: string
    clientWhere: Prisma.ClientWhereInput
  },
) {
  const client = await tx.client.findFirst({
    where: {
      ...args.clientWhere,
      tenantId: args.tenantId,
    },
    select: portalClientKycSelect,
  })
  if (!client) return null

  const { latestSelfieId, ...composite } = await readCompositeKycState(
    tx,
    {
      tenantId: args.tenantId,
      clientId: client.id,
      subject: client,
      existing: client,
      preserveVerifiedProvenance: true,
    },
  )

  return {
    ...client,
    kycChecklist: derivePortalKycChecklist({
      documents: client.documents,
      composite,
      latestSelfieId,
    }),
  }
}
