/**
 * The one write path for a lender's staff access restrictions
 * (TenantConfig.staffAccessHours / staffIpAllowlist). Validated input only
 * (parseStaffAccessHours, parseIpAllowlist); the change and its audit row
 * commit together, serialised per tenant; an unchanged policy writes nothing.
 *
 * No session is signed out here: the jwt callback re-reads the policy on
 * every request (lib/security/staff-access-enforcement.ts), so a narrowed
 * policy takes effect on each staff member's next request.
 */
import { Prisma } from "@prisma/client"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { parseStaffAccessHours, type StaffAccessHours } from "./staff-access-hours"

type PolicyTx = Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig" | "auditLog">

export type StaffAccessPolicyInput = { hours: StaffAccessHours | null; ipAllowlist: string[] }

export async function applyStaffAccessPolicy(
  tx: PolicyTx,
  args: { tenantId: string; actor: { id: string; email: string }; next: StaffAccessPolicyInput; ipAddress?: string },
): Promise<{ changed: boolean }> {
  const { tenantId, actor, next, ipAddress } = args
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-access-policy:${tenantId}`}))`
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const stored = await tx.tenantConfig.findUnique({
    where: { tenantId },
    select: { staffAccessHours: true, staffIpAllowlist: true },
  })
  const storedHours = stored?.staffAccessHours ?? null
  // JSONB does not keep key order; re-parse so equal policies compare equal.
  const parsedHours = storedHours === null ? null : parseStaffAccessHours(storedHours)
  const previous = {
    hours: parsedHours === null ? null : parsedHours.ok ? parsedHours.hours : storedHours,
    ipAllowlist: stored?.staffIpAllowlist ?? [],
  }
  if (JSON.stringify(previous) === JSON.stringify(next)) return { changed: false }

  const data = {
    staffAccessHours: next.hours === null ? Prisma.DbNull : (next.hours as Prisma.InputJsonValue),
    staffIpAllowlist: next.ipAllowlist,
  }
  await tx.tenantConfig.upsert({ where: { tenantId }, update: data, create: { tenantId, ...data } })
  await logAuditStrict({
    tenantId,
    userId: actor.id,
    userEmail: actor.email,
    action: AuditAction.STAFF_ACCESS_POLICY_UPDATED,
    entity: "TenantConfig",
    entityId: tenantId,
    oldValue: previous,
    newValue: next,
    ipAddress,
  }, tx)
  return { changed: true }
}
