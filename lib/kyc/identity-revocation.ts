import type { Client, Prisma } from "@prisma/client"
import type { prisma as ScopedPrismaClient } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import {
  biometricSubjectFingerprint,
  type BiometricSubjectClient,
} from "@/lib/kyc/biometric-evidence"

type IdentityKycState = BiometricSubjectClient & Pick<
  Client,
  "kycStatus" | "kycVerifiedAt" | "kycVerifiedById" | "kycVerificationMethod"
>

type ScopedTransactionClient = Parameters<
  Parameters<typeof ScopedPrismaClient.$transaction>[0]
>[0]

type IdentityMutationTransaction = Pick<
  ScopedTransactionClient,
  "client" | "clientDocument" | "auditLog"
>

export type BiometricIdentityRevocation = {
  reason: "client_identity_changed"
  source: string
  previousSubjectFingerprint: string
  currentSubjectFingerprint: string
  invalidatedDocumentIds: string[]
  invalidatedDocumentCount: number
}

function kycAuditValue(state: Pick<
  IdentityKycState,
  "kycStatus" | "kycVerifiedAt" | "kycVerifiedById" | "kycVerificationMethod"
>) {
  return {
    kycStatus: state.kycStatus,
    kycVerifiedAt: state.kycVerifiedAt?.toISOString() ?? null,
    kycVerifiedById: state.kycVerifiedById,
    kycVerificationMethod: state.kycVerificationMethod,
  }
}

/**
 * The only supported writer for an existing client's Smile subject fields.
 * Callers must already hold the client evidence lock; this helper keeps the
 * identity update, KYC reset, selfie invalidation, and audit in one DB tx.
 */
export async function updateClientWithBiometricIdentityRevocation(
  tx: IdentityMutationTransaction,
  args: {
    tenantId: string
    clientId: string
    previous: IdentityKycState
    nextSubject: BiometricSubjectClient
    where: Prisma.ClientWhereUniqueInput
    data: Prisma.ClientUncheckedUpdateInput
    actor: { userId: string | null; userEmail: string | null }
    source: string
    /**
     * Set when the caller refused this revocation first and the operator
     * explicitly acknowledged it. Recorded on the audit row so a reader can
     * tell a warned, deliberate revocation from one nothing announced —
     * without it, the two are indistinguishable after the fact.
     */
    acknowledged?: boolean
    ipAddress?: string | null
  },
): Promise<{ client: Client; revocation: BiometricIdentityRevocation | null }> {
  const previousSubjectFingerprint = biometricSubjectFingerprint(args.previous)
  const currentSubjectFingerprint = biometricSubjectFingerprint(args.nextSubject)
  const identityChanged = previousSubjectFingerprint !== currentSubjectFingerprint

  const verifiedSelfies = identityChanged
    ? await tx.clientDocument.findMany({
        where: {
          tenantId: args.tenantId,
          clientId: args.clientId,
          docType: "SELFIE",
          deletedAt: null,
          verified: true,
        },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    : []

  const client = await tx.client.update({
    where: args.where,
    data: {
      ...args.data,
      ...(identityChanged && {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      }),
    },
  })

  if (!identityChanged) return { client, revocation: null }

  if (verifiedSelfies.length > 0) {
    const invalidated = await tx.clientDocument.updateMany({
      where: {
        tenantId: args.tenantId,
        clientId: args.clientId,
        docType: "SELFIE",
        deletedAt: null,
        verified: true,
        id: { in: verifiedSelfies.map(({ id }) => id) },
      },
      data: {
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: "Client identity changed; repeat biometric verification before disbursement.",
      },
    })
    if (invalidated.count !== verifiedSelfies.length) {
      throw new Error("Biometric evidence changed concurrently; refresh and try again")
    }
  }

  const revocation: BiometricIdentityRevocation = {
    reason: "client_identity_changed",
    source: args.source,
    previousSubjectFingerprint,
    currentSubjectFingerprint,
    invalidatedDocumentIds: verifiedSelfies.map(({ id }) => id),
    invalidatedDocumentCount: verifiedSelfies.length,
  }

  await tx.auditLog.create({
    data: {
      tenantId: args.tenantId,
      userId: args.actor.userId,
      userEmail: args.actor.userEmail,
      action: AuditAction.KYC_STATUS_CHANGED,
      entity: "Client",
      entityId: args.clientId,
      oldValue: {
        source: args.source,
        subjectFingerprint: previousSubjectFingerprint,
        clientKyc: kycAuditValue(args.previous),
      },
      newValue: {
        source: args.source,
        reason: revocation.reason,
        subjectFingerprint: currentSubjectFingerprint,
        clientKyc: kycAuditValue(client),
        invalidatedDocumentIds: revocation.invalidatedDocumentIds,
        invalidatedDocumentCount: revocation.invalidatedDocumentCount,
        ...(args.acknowledged === undefined
          ? {}
          : { acknowledgedIdentityRevocation: args.acknowledged }),
      },
      ipAddress: args.ipAddress ?? null,
    },
  })

  return { client, revocation }
}
