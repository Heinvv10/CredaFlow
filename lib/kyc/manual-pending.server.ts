import type { prisma } from "@/lib/prisma"
import type { ClientKycState } from "@/lib/kyc/document-state"

type RawQueryDb = Pick<typeof prisma, "$queryRaw">

/**
 * True while a staff member's deliberate manual PENDING holds the client. The
 * manual override (PATCH /api/clients/[id]) records it as a KYC_STATUS_CHANGED
 * row on the Client with manualOverride and kycStatus PENDING; no column
 * stamps it, so the audit trail is the record. Resolving a manual rejection to
 * PENDING writes the same row, so it starts a new hold.
 *
 * It stands until a later audit row, on the client or on any of its documents
 * (the verify, selfie and delete paths audit the document), records the client
 * VERIFIED. A FAILED or EXPIRED in between does not end it: the hold applies
 * while the stored status is anything but VERIFIED (holdManualPending), so a
 * refusal or a failed selfie cannot be followed by an automatic promotion. No
 * automatic path records VERIFIED while it stands, so only an explicit staff
 * decision ends it: Approve KYC, or a staff grant that records VERIFIED (senior
 * exception, in-person attestation). Reject KYC does not. Writers record the
 * post-write status as newValue.clientKyc.kycStatus, the manual override and
 * the bank-detail revocation as newValue.kycStatus.
 *
 * Both lookups go through the AuditLog (entity, entityId) index. "Later" is a
 * strictly later createdAt: a row in the same millisecond as the manual one
 * keeps the hold standing. Limit: createdAt is stamped by the writing process
 * when Prisma builds the INSERT (its clock, not the database's, not commit
 * time); a row inserted by raw SQL takes its transaction's start time. Rows
 * written under the client evidence lock on one host sort in lock order; rows
 * from hosts with skewed clocks, or written outside that lock, can sort either
 * side of the manual row.
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
            ) = 'VERIFIED'
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
 * PENDING stands, a derived VERIFIED for a client not stored VERIFIED (PENDING,
 * or FAILED after a refusal) is stored PENDING; demotions and every other
 * state pass through unchanged. Call it
 * under the client evidence lock, with the stored status read under that lock.
 * Only a promotion pays for the audit-trail read.
 */
export async function holdManualPending(
  db: RawQueryDb,
  args: { tenantId: string; clientId: string; storedKycStatus: string; state: ClientKycState },
): Promise<ClientKycState> {
  if (args.state.kycStatus !== "VERIFIED" || args.storedKycStatus === "VERIFIED") return args.state
  return (await manualPendingStands(db, args)) ? HELD_PENDING : args.state
}
