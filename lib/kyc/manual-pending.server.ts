import type { prisma } from "@/lib/prisma"
import type { ClientKycState } from "@/lib/kyc/document-state"

type RawQueryDb = Pick<typeof prisma, "$queryRaw">

/**
 * True while a staff member's deliberate manual PENDING is the client's latest
 * KYC status change. The manual override (PATCH /api/clients/[id]) records it
 * as a KYC_STATUS_CHANGED row on the Client with manualOverride and kycStatus
 * PENDING; no column stamps it, so the audit trail is the record. Resolving a
 * manual rejection to PENDING writes the same row and holds the same way.
 *
 * It stands until a later audit row, on the client or on any of its documents
 * (the verify, selfie and delete paths audit the document), records the client
 * in a status other than PENDING. While it stands no automatic path promotes
 * (holdManualPending), so in practice only staff's explicit Approve KYC, Reject
 * KYC or another manual status ends it. Writers record the post-write status
 * as newValue.clientKyc.kycStatus, the manual override and the bank-detail
 * revocation as newValue.kycStatus. A row that records no status (an upload, a
 * refused access) changes nothing.
 *
 * Both lookups go through the AuditLog (entity, entityId) index. "Later" is a
 * strictly later createdAt: a row in the same millisecond as the manual one
 * keeps the hold standing, which withholds a promotion rather than allowing one.
 */
export async function manualPendingStands(
  db: RawQueryDb,
  args: { tenantId: string; clientId: string },
): Promise<boolean> {
  const { tenantId, clientId } = args
  const rows = await db.$queryRaw<Array<{ stands: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "AuditLog" manual
      WHERE manual."tenantId" = ${tenantId}
        AND manual."entity" = 'Client'
        AND manual."entityId" = ${clientId}
        AND manual."action" = 'KYC_STATUS_CHANGED'
        AND manual."newValue"->>'manualOverride' = 'true'
        AND manual."newValue"->>'kycStatus' = 'PENDING'
        AND NOT EXISTS (
          SELECT 1 FROM "AuditLog" later
          WHERE later."tenantId" = ${tenantId}
            AND (
              (later."entity" = 'Client' AND later."entityId" = ${clientId})
              OR (later."entity" = 'ClientDocument' AND later."entityId" IN (
                SELECT document."id" FROM "ClientDocument" document
                WHERE document."tenantId" = ${tenantId} AND document."clientId" = ${clientId}
              ))
            )
            AND later."createdAt" > manual."createdAt"
            AND COALESCE(
              later."newValue"->'clientKyc'->>'kycStatus',
              later."newValue"->>'kycStatus'
            ) <> 'PENDING'
        )
    ) AS "stands"`
  return rows[0]?.stands === true
}

const HELD_PENDING: ClientKycState = {
  kycStatus: "PENDING",
  kycVerifiedAt: null,
  kycVerifiedById: null,
  kycVerificationMethod: null,
}

/**
 * The KYC state an automatic writer (document verify/refuse, document delete,
 * selfie outcome, sweeper, evidence invalidation) may store. While a manual
 * PENDING stands, a derived VERIFIED for a stored-PENDING client stays
 * PENDING; demotions and every other state pass through unchanged. Call it
 * under the client evidence lock, with the stored status read under that lock.
 * Only a promotion pays for the audit-trail read.
 */
export async function holdManualPending(
  db: RawQueryDb,
  args: { tenantId: string; clientId: string; storedKycStatus: string; state: ClientKycState },
): Promise<ClientKycState> {
  if (args.state.kycStatus !== "VERIFIED" || args.storedKycStatus !== "PENDING") return args.state
  return (await manualPendingStands(db, args)) ? HELD_PENDING : args.state
}
