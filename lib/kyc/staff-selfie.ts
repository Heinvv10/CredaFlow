import { prisma } from "@/lib/prisma"
import { latestSelfieOrder } from "@/lib/kyc/document-state"

export const STAFF_SELFIE_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  storagePath: true,
  deletedAt: true,
  biometricMatchScore: true,
  biometricLiveness: true,
  biometricVerifiedAt: true,
  extractionStatus: true,
  verified: true,
  verifiedAt: true,
  verificationNote: true,
  createdAt: true,
} as const

/**
 * Read the authoritative latest attempt, including a soft-deleted attempt.
 * A deleted latest attempt must be rendered as a tombstone; falling through
 * to older accepted evidence would contradict the transition gates.
 */
export function getAuthoritativeStaffSelfie(clientId: string, tenantId: string) {
  return prisma.clientDocument.findFirst({
    where: { tenantId, clientId, docType: "SELFIE" },
    orderBy: latestSelfieOrder(),
    select: STAFF_SELFIE_SELECT,
  })
}
