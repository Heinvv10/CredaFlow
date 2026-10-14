import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"

type OverrideRequestActor = { id: string; email: string }

/**
 * Lazy request expiry used by every application read path. Expiry is a real
 * state transition, so it is committed with one audit row per request.
 */
export async function expireAndListPendingKycOverrideRequests(args: {
  tenantId: string
  clientId: string
  actor: OverrideRequestActor
}) {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const expired = await tx.kycOverrideRequest.findMany({
      where: {
        tenantId: args.tenantId,
        clientId: args.clientId,
        status: "PENDING",
        expiresAt: { lt: now },
      },
      select: { id: true },
    })
    for (const request of expired) {
      const changed = await tx.kycOverrideRequest.updateMany({
        where: {
          id: request.id,
          tenantId: args.tenantId,
          status: "PENDING",
          expiresAt: { lt: now },
        },
        data: {
          status: "EXPIRED",
          decidedById: args.actor.id,
          decidedAt: now,
          decisionNote: "Expired automatically after 7 days.",
        },
      })
      if (changed.count === 0) continue
      await logAuditStrict({
        tenantId: args.tenantId,
        userId: args.actor.id,
        userEmail: args.actor.email,
        action: AuditAction.KYC_OVERRIDE_EXPIRED,
        entity: "KycOverrideRequest",
        entityId: request.id,
        oldValue: { status: "PENDING" },
        newValue: { status: "EXPIRED", decidedAt: now.toISOString() },
      }, tx)
    }
    return tx.kycOverrideRequest.findMany({
      where: { tenantId: args.tenantId, clientId: args.clientId, status: "PENDING" },
      orderBy: { requestedAt: "desc" },
      select: {
        id: true,
        kind: true,
        requestedById: true,
        requestedAt: true,
        expiresAt: true,
        requestedBy: { select: { email: true, name: true } },
      },
    })
  // ReadCommitted plus the conditional update makes concurrent page reads
  // converge without one render being aborted by Serializable/P2034.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
}
