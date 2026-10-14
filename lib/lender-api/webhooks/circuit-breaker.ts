import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"

/**
 * Per-endpoint circuit breaker. Every attempt's outcome updates the endpoint:
 * a success resets consecutiveFailures, a failure adds one, and the failure
 * that reaches CIRCUIT_BREAKER_FAILURES pauses the endpoint (pausedAt). A
 * paused endpoint's deliveries stay PENDING and are not claimed (so they burn
 * no attempts) until an admin resumes it in Settings. The pause is audited
 * with no user (the system did it) in the same transaction.
 */
export const CIRCUIT_BREAKER_FAILURES = 20

export async function recordEndpointOutcome(endpoint: { id: string; tenantId: string }, ok: boolean, error: string | null): Promise<"paused" | null> {
  if (ok) {
    await prisma.webhookEndpoint.updateMany({
      where: { id: endpoint.id, tenantId: endpoint.tenantId, consecutiveFailures: { gt: 0 } },
      data: { consecutiveFailures: 0 },
    })
    return null
  }
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ consecutiveFailures: number; pausedAt: Date | null }>>(Prisma.sql`
      UPDATE "WebhookEndpoint" SET "consecutiveFailures" = "consecutiveFailures" + 1
      WHERE "id" = ${endpoint.id} AND "tenantId" = ${endpoint.tenantId}
      RETURNING "consecutiveFailures", "pausedAt"`)
    if (!row || row.pausedAt || row.consecutiveFailures < CIRCUIT_BREAKER_FAILURES) return null
    const reason = `${row.consecutiveFailures} failed deliveries in a row; last: ${(error ?? "unknown").slice(0, 200)}`
    const { count } = await tx.webhookEndpoint.updateMany({
      where: { id: endpoint.id, tenantId: endpoint.tenantId, pausedAt: null },
      data: { pausedAt: new Date(), pausedReason: reason },
    })
    if (count === 0) return null // another attempt of the same run paused it first
    await logAuditStrict({
      tenantId: endpoint.tenantId,
      action: AuditAction.WEBHOOK_ENDPOINT_PAUSED,
      entity: "WebhookEndpoint",
      entityId: endpoint.id,
      newValue: { consecutiveFailures: row.consecutiveFailures, reason },
    }, tx)
    return "paused" as const
  })
}

/** Resume a paused endpoint (Settings, ADMIN with 2FA), audited. */
export async function resumeWebhookEndpoint(args: { tenantId: string; endpointId: string; actor: { id: string; email: string; ipAddress?: string } }): Promise<"resumed" | "not_paused" | "not_found"> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.webhookEndpoint.updateMany({
      where: { id: args.endpointId, tenantId: args.tenantId, active: true, pausedAt: { not: null } },
      data: { pausedAt: null, pausedReason: null, consecutiveFailures: 0 },
    })
    if (count === 0) {
      const exists = await tx.webhookEndpoint.findFirst({ where: { id: args.endpointId, tenantId: args.tenantId }, select: { id: true } })
      return exists ? "not_paused" : "not_found"
    }
    await logAuditStrict({
      tenantId: args.tenantId,
      userId: args.actor.id,
      userEmail: args.actor.email,
      action: AuditAction.WEBHOOK_ENDPOINT_RESUMED,
      entity: "WebhookEndpoint",
      entityId: args.endpointId,
      newValue: { resumedAt: new Date().toISOString() },
      ipAddress: args.actor.ipAddress,
    }, tx)
    return "resumed"
  })
}
