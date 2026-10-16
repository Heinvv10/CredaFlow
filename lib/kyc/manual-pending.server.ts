import type { prisma } from "@/lib/prisma"

/**
 * True while a staff member's deliberate manual PENDING is the client's latest
 * KYC status change. The manual override (PATCH /api/clients/[id]) records it
 * as a KYC_STATUS_CHANGED row on the Client with manualOverride and kycStatus
 * PENDING; no column stamps it, so the audit trail is the record.
 *
 * It stands until a later audit row, on the client or on any of its documents
 * (the verify, selfie and delete paths audit the document), records the client
 * in a status other than PENDING: that is the status leaving PENDING, after
 * which a fresh fall back to PENDING is no longer the staff member's choice.
 * Writers record the post-write status as newValue.clientKyc.kycStatus, the
 * manual override and the bank-detail revocation as newValue.kycStatus. A row
 * that records no status (an upload, a refused access) changes nothing.
 *
 * Both lookups go through the AuditLog (entity, entityId) index. Ties on
 * createdAt break on id; a tie read the wrong way keeps the manual PENDING
 * standing, which hides a hint rather than offering one.
 */
export async function manualPendingStands(
  db: Pick<typeof prisma, "$queryRaw">,
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
            AND (later."createdAt", later."id") > (manual."createdAt", manual."id")
            AND COALESCE(
              later."newValue"->'clientKyc'->>'kycStatus',
              later."newValue"->>'kycStatus'
            ) <> 'PENDING'
        )
    ) AS "stands"`
  return rows[0]?.stands === true
}
