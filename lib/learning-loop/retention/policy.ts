/**
 * The lender's credit decision log retention period:
 * `TenantConfig.decisionRecordRetentionMonths` (DESIGN.md §2.7). null = off,
 * and there is no default: nothing is pseudonymised until a SUPER_ADMIN in a
 * TOTP-verified session sets a period. The one write path is
 * applyDecisionRecordRetention.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { prisma } from "@/lib/prisma"

/** FICA keeps records for five years, longer than the NCA regulations' three (DESIGN.md §2.7). */
export const RETENTION_MONTHS_MIN = 60
export const RETENTION_MONTHS_MAX = 600

export function isRetentionMonths(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= RETENTION_MONTHS_MIN && value <= RETENTION_MONTHS_MAX
}

export type DecisionRetentionState = {
  months: number | null
  /** The latest change, from its audit row; null when the setting was never changed. */
  lastChange: { at: Date; byEmail: string | null } | null
}

export async function getDecisionRetentionState(tenantId: string): Promise<DecisionRetentionState> {
  const [config, last] = await Promise.all([
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { decisionRecordRetentionMonths: true } }),
    prisma.auditLog.findFirst({
      where: { tenantId, action: AuditAction.DECISION_RECORD_RETENTION_UPDATED, entity: "TenantConfig", entityId: tenantId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, userEmail: true },
    }),
  ])
  return {
    months: config?.decisionRecordRetentionMonths ?? null,
    lastChange: last ? { at: last.createdAt, byEmail: last.userEmail } : null,
  }
}

type RetentionTx = Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig" | "auditLog">

/**
 * Set the period inside the caller's transaction (which has already checked
 * the actor's role and TOTP-verified session). The change and its audit row
 * commit together. An unchanged value writes and audits nothing.
 */
export async function applyDecisionRecordRetention(
  tx: RetentionTx,
  args: { tenantId: string; actor: { id: string; email: string }; months: number | null; ipAddress?: string },
): Promise<{ changed: boolean; months: number | null }> {
  const { tenantId, actor, months, ipAddress } = args
  // As the staff 2FA setting: with no config row there is no row to lock, so serialise on the tenant first.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`decision-record-retention:${tenantId}`}))`
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const stored = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { decisionRecordRetentionMonths: true } })
  const previous = stored?.decisionRecordRetentionMonths ?? null
  if (previous === months) return { changed: false, months }

  await tx.tenantConfig.upsert({
    where: { tenantId },
    update: { decisionRecordRetentionMonths: months },
    create: { tenantId, decisionRecordRetentionMonths: months },
  })
  await logAuditStrict({
    tenantId,
    userId: actor.id,
    userEmail: actor.email,
    action: AuditAction.DECISION_RECORD_RETENTION_UPDATED,
    entity: "TenantConfig",
    entityId: tenantId,
    oldValue: { decisionRecordRetentionMonths: previous },
    newValue: { decisionRecordRetentionMonths: months },
    ipAddress,
  }, tx)
  return { changed: true, months }
}
